package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	kinstream "github.com/dofastted/kin-gateway/worker/internal/stream"
	"github.com/dofastted/kin-gateway/worker/internal/upstream"
)

type Server struct {
	Config    config.Config
	Store     *credential.Store
	Refresher *kinoauth.Refresher
	Upstream  *upstream.Client
	startedAt time.Time
	mu        sync.Mutex
	lastError string
}

type messageRequest struct {
	Body         json.RawMessage   `json:"body"`
	Headers      map[string]string `json:"headers"`
	Stream       bool              `json:"stream"`
	DeliveryMode string            `json:"delivery_mode"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", s.authorize(s.health))
	mux.HandleFunc("GET /internal/credential/status", s.authorize(s.credentialStatus))
	mux.HandleFunc("POST /internal/credential/import", s.authorize(s.credentialImport))
	mux.HandleFunc("POST /internal/credential/ensure", s.authorize(s.credentialEnsure))
	mux.HandleFunc("POST /internal/v1/messages", s.authorize(s.messages))
	mux.HandleFunc("GET /internal/v1/models", s.authorize(s.models))
	mux.HandleFunc("GET /internal/oauth/usage", s.authorize(s.usage))
	return mux
}

func (s *Server) StartBackgroundRefresh(ctx context.Context) {
	if s.Refresher == nil {
		return
	}
	s.Refresher.Start(ctx, time.Minute, func(_ kinoauth.Result, err error) {
		if err != nil {
			s.setLastError(err)
			return
		}
		s.setLastError(nil)
	})
}

func (s *Server) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if token := strings.TrimSpace(s.Config.InternalToken); token != "" {
			provided := request.Header.Get("X-Kin-Internal-Token")
			if subtle.ConstantTimeCompare([]byte(token), []byte(provided)) != 1 {
				writeJSON(writer, http.StatusUnauthorized, map[string]any{
					"ok":    false,
					"error": map[string]any{"code": "internal_auth_failed", "message": "Internal worker authentication failed"},
				})
				return
			}
		}
		next(writer, request)
	}
}

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	current, err := s.Store.Status()
	if err != nil {
		s.setLastError(err)
	}
	usable := err == nil && (current.Valid() || strings.TrimSpace(current.RefreshToken) != "")
	status := "ready"
	if !usable {
		status = "degraded"
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok":               usable,
		"status":           status,
		"vm_id":            s.Config.VMID,
		"proxy_configured": strings.TrimSpace(s.Config.ProxyURL) != "",
		"proxy_required":   s.Config.ProxyRequired,
		"credential":       publicCredential(current),
		"delivery_mode":    s.Config.DeliveryMode,
		"uptime_seconds":   int64(time.Since(s.started()).Seconds()),
		"last_error":       s.getLastError(),
		"last_error_class": classifyRefreshError(s.getLastError()),
	})
}

func (s *Server) credentialStatus(writer http.ResponseWriter, _ *http.Request) {
	current, err := s.Store.Status()
	if err != nil {
		writeWorkerError(writer, http.StatusServiceUnavailable, "credential_unavailable", err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok":         current.Valid() || strings.TrimSpace(current.RefreshToken) != "",
		"credential": publicCredential(current),
	})
}

func (s *Server) credentialImport(writer http.ResponseWriter, request *http.Request) {
	current, err := credential.DecodeImport(request.Body, s.Config.MaxRequestBytes)
	if err != nil {
		writeWorkerError(writer, http.StatusBadRequest, "credential_import_invalid", err)
		return
	}
	if !current.Valid() {
		writeWorkerError(writer, http.StatusBadRequest, "credential_import_invalid", errors.New("access token is required"))
		return
	}
	err = s.Store.WithLock(request.Context(), func() error {
		var document map[string]any
		_, loaded, loadErr := s.Store.Load()
		if loadErr == nil {
			document = loaded
		} else if !errors.Is(loadErr, os.ErrNotExist) {
			return loadErr
		}
		saved, saveErr := s.Store.Save(current, document)
		if saveErr == nil {
			current = saved
		}
		return saveErr
	})
	if err != nil {
		writeWorkerError(writer, http.StatusInternalServerError, "credential_import_failed", err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"ok": true, "credential": publicCredential(current)})
}

func (s *Server) credentialEnsure(writer http.ResponseWriter, request *http.Request) {
	force := request.URL.Query().Get("force") == "1"
	result, err := s.Refresher.Ensure(request.Context(), force)
	if err != nil {
		s.setLastError(err)
		writeWorkerError(writer, http.StatusBadGateway, "credential_refresh_failed", err)
		return
	}
	s.setLastError(nil)
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok":         true,
		"refreshed":  result.Refreshed,
		"shared":     result.Shared,
		"credential": publicCredential(result.Credential),
	})
}

func (s *Server) messages(writer http.ResponseWriter, request *http.Request) {
	var input messageRequest
	decoder := json.NewDecoder(io.LimitReader(request.Body, s.Config.MaxRequestBytes))
	if err := decoder.Decode(&input); err != nil {
		writeWorkerError(writer, http.StatusBadRequest, "worker_request_invalid", err)
		return
	}
	if len(input.Body) == 0 || !json.Valid(input.Body) {
		writeWorkerError(writer, http.StatusBadRequest, "worker_request_invalid", errors.New("body must be valid JSON"))
		return
	}
	input.Body = applyStreamFlag(input.Body, input.Stream)
	response, err := s.Upstream.Messages(request.Context(), input.Body, input.Headers)
	if err != nil {
		s.setLastError(err)
		writeWorkerError(writer, http.StatusBadGateway, "upstream_transport_error", err)
		return
	}
	defer response.Body.Close()
	if response.Status < 200 || response.Status >= 300 {
		s.forwardError(writer, response)
		return
	}
	if !input.Stream {
		s.nonStream(writer, response)
		return
	}
	mode := input.DeliveryMode
	if mode == "" {
		mode = s.Config.DeliveryMode
	}
	if mode == "verified" {
		s.verifiedStream(writer, request.Context(), response)
		return
	}
	s.realtimeStream(writer, request.Context(), response)
}

func (s *Server) nonStream(writer http.ResponseWriter, response *upstream.Response) {
	data, err := readLimited(response.Body, s.Config.MaxResponseBytes)
	if err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "upstream_response_invalid", err)
		return
	}
	if err = kinstream.ValidateMessageJSON(data); err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "upstream_terminal_invalid", err)
		return
	}
	copyResponseHeaders(writer.Header(), response.Header)
	writer.Header().Set("X-Kin-Terminal-State", "verified")
	writer.WriteHeader(response.Status)
	_, _ = writer.Write(data)
}

func (s *Server) verifiedStream(writer http.ResponseWriter, ctx context.Context, response *upstream.Response) {
	var output bytes.Buffer
	result, err := kinstream.Pump(ctx, response.Body, s.streamOptions(), func(event kinstream.Event) error {
		if int64(output.Len()+len(event.Raw)) > s.Config.MaxResponseBytes {
			return errors.New("verified stream exceeds response limit")
		}
		_, writeErr := output.Write(event.Raw)
		return writeErr
	})
	if err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "upstream_terminal_invalid", err)
		return
	}
	copyResponseHeaders(writer.Header(), response.Header)
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("X-Kin-Terminal-State", "verified")
	writer.Header().Set("X-Kin-Event-Count", fmt.Sprint(result.EventCount))
	setStreamMeta(writer.Header(), result)
	writer.WriteHeader(response.Status)
	_, _ = writer.Write(output.Bytes())
}

// setStreamMeta exposes the merged protocol metadata collected by the SSE
// validator (usage JSON, upstream model, stop reason) as X-Kin-* headers or
// trailers so the gateway can persist them for stream requests too.
func setStreamMeta(header http.Header, result kinstream.Result) {
	if result.Usage != nil {
		if data, err := json.Marshal(result.Usage); err == nil {
			header.Set("X-Kin-Usage", string(data))
		}
	}
	if result.Model != "" {
		header.Set("X-Kin-Model", result.Model)
	}
	if result.StopReason != "" {
		header.Set("X-Kin-Stop-Reason", result.StopReason)
	}
}

func (s *Server) realtimeStream(writer http.ResponseWriter, ctx context.Context, response *upstream.Response) {
	copyResponseHeaders(writer.Header(), response.Header)
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Trailer", "X-Kin-Terminal-State, X-Kin-Event-Count, X-Kin-Usage, X-Kin-Model, X-Kin-Stop-Reason")
	committed := false
	result, err := kinstream.Pump(ctx, response.Body, s.streamOptions(), func(event kinstream.Event) error {
		if !committed {
			writer.WriteHeader(response.Status)
			committed = true
		}
		if _, writeErr := writer.Write(event.Raw); writeErr != nil {
			return writeErr
		}
		if flusher, ok := writer.(http.Flusher); ok {
			flusher.Flush()
		}
		return nil
	})
	if err != nil {
		if !committed {
			writeWorkerError(writer, http.StatusBadGateway, "upstream_terminal_invalid", err)
			return
		}
		errorPayload, _ := json.Marshal(map[string]any{
			"type":  "error",
			"error": map[string]any{"type": "api_error", "message": "Upstream stream ended before a valid terminal event"},
		})
		_, _ = fmt.Fprintf(writer, "event: error\ndata: %s\n\n", errorPayload)
		writer.Header().Set("X-Kin-Terminal-State", "incomplete")
		writer.Header().Set("X-Kin-Event-Count", fmt.Sprint(result.EventCount))
		setStreamMeta(writer.Header(), result)
		return
	}
	writer.Header().Set("X-Kin-Terminal-State", "verified")
	writer.Header().Set("X-Kin-Event-Count", fmt.Sprint(result.EventCount))
	setStreamMeta(writer.Header(), result)
}

func (s *Server) models(writer http.ResponseWriter, request *http.Request) {
	response, err := s.Upstream.Get(request.Context(), "/v1/models", map[string]string{"Accept": "application/json"})
	if err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "models_transport_error", err)
		return
	}
	defer response.Body.Close()
	s.copyGeneric(writer, response)
}

func (s *Server) usage(writer http.ResponseWriter, request *http.Request) {
	response, err := s.Upstream.Get(request.Context(), "/api/oauth/usage", map[string]string{
		"Accept":         "application/json",
		"Anthropic-Beta": "oauth-2025-04-20",
	})
	if err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "usage_transport_error", err)
		return
	}
	defer response.Body.Close()
	s.copyGeneric(writer, response)
}

func (s *Server) copyGeneric(writer http.ResponseWriter, response *upstream.Response) {
	data, err := readLimited(response.Body, s.Config.MaxResponseBytes)
	if err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "upstream_response_invalid", err)
		return
	}
	copyResponseHeaders(writer.Header(), response.Header)
	writer.WriteHeader(response.Status)
	_, _ = writer.Write(data)
}

func (s *Server) forwardError(writer http.ResponseWriter, response *upstream.Response) {
	data, err := readLimited(response.Body, min64(s.Config.MaxResponseBytes, 1<<20))
	if err != nil {
		writeWorkerError(writer, http.StatusBadGateway, "upstream_error_invalid", err)
		return
	}
	copyResponseHeaders(writer.Header(), response.Header)
	writer.Header().Set("Content-Type", contentTypeOrJSON(response.Header))
	writer.WriteHeader(response.Status)
	_, _ = writer.Write(data)
}

func applyStreamFlag(body json.RawMessage, stream bool) json.RawMessage {
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil || obj == nil {
		return body
	}
	current, isBool := obj["stream"].(bool)
	if isBool && current == stream {
		return body
	}
	obj["stream"] = stream
	out, err := json.Marshal(obj)
	if err != nil {
		return body
	}
	return out
}

func (s *Server) streamOptions() kinstream.Options {
	return kinstream.Options{
		MaxEventBytes: s.Config.MaxEventBytes,
		FirstByte:     s.Config.FirstByteTimeout,
		Idle:          s.Config.IdleTimeout,
	}
}

func (s *Server) started() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.startedAt.IsZero() {
		s.startedAt = time.Now()
	}
	return s.startedAt
}

func (s *Server) setLastError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil {
		s.lastError = ""
		return
	}
	s.lastError = err.Error()
	if len(s.lastError) > 300 {
		s.lastError = s.lastError[:300]
	}
}

func (s *Server) getLastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastError
}

func classifyRefreshError(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "invalid_grant"), strings.Contains(lower, "refresh_token_missing"), strings.Contains(lower, "revoked"):
		return "fatal"
	case strings.Contains(lower, "timeout"), strings.Contains(lower, "network"), strings.Contains(lower, "transport"), strings.Contains(lower, "429"):
		return "retryable"
	case strings.TrimSpace(lower) == "":
		return ""
	default:
		return "failed"
	}
}

func publicCredential(current credential.Credential) map[string]any {
	ttl := int64(0)
	if current.ExpiresAt > 0 {
		ttl = int64(time.Until(time.UnixMilli(current.ExpiresAt)).Seconds())
	}
	state := "missing"
	switch {
	case strings.TrimSpace(current.RefreshToken) != "" && !current.Valid():
		state = "refreshable"
	case current.ExpiresAt > 0 && current.ExpiresAt <= time.Now().UnixMilli():
		if strings.TrimSpace(current.RefreshToken) != "" {
			state = "expired_refreshable"
		} else {
			state = "expired"
		}
	case current.NeedsRefresh(time.Now(), 5*time.Minute):
		state = "refresh_window"
	case current.Valid():
		state = "fresh"
	}
	return map[string]any{
		"has_access":       current.AccessToken != "",
		"has_refresh":      current.RefreshToken != "",
		"expires_at":       current.ExpiresAt,
		"ttl_seconds":      ttl,
		"generation":       current.Generation,
		"email":            current.Email,
		"account_uuid":     current.AccountUUID,
		"org_uuid":         current.OrgUUID,
		"needs_refresh":    current.NeedsRefresh(time.Now(), 5*time.Minute),
		"credential_state": state,
	}
}

func copyResponseHeaders(destination, source http.Header) {
	for key, values := range source {
		lower := strings.ToLower(key)
		if lower == "content-length" || lower == "connection" || lower == "transfer-encoding" || lower == "set-cookie" {
			continue
		}
		if lower == "authorization" || lower == "x-api-key" {
			continue
		}
		destination.Del(key)
		for _, value := range values {
			destination.Add(key, value)
		}
	}
}

func contentTypeOrJSON(header http.Header) string {
	if value := header.Get("Content-Type"); value != "" {
		return value
	}
	return "application/json"
}

func readLimited(reader io.Reader, max int64) ([]byte, error) {
	if max <= 0 {
		max = 64 << 20
	}
	limited := &io.LimitedReader{R: reader, N: max + 1}
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("response exceeds %d bytes", max)
	}
	return data, nil
}

func writeWorkerError(writer http.ResponseWriter, status int, code string, err error) {
	message := code
	if err != nil {
		message = err.Error()
	}
	if len(message) > 300 {
		message = message[:300]
	}
	writeJSON(writer, status, map[string]any{
		"ok": false,
		"error": map[string]any{
			"type":    "worker_error",
			"code":    code,
			"message": message,
		},
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

func min64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
