package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
	"github.com/dofastted/kin-gateway/worker/internal/upstream"
)

func TestMessagesNonStreamRequiresCompleteMessage(t *testing.T) {
	anthropic := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer access" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer anthropic.Close()
	worker := testServer(t, anthropic.URL)
	payload := messageEnvelope(false, "realtime")
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/messages", bytes.NewReader(payload))
	recorder := httptest.NewRecorder()
	worker.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("X-Kin-Terminal-State") != "verified" {
		t.Fatalf("terminal state = %q", recorder.Header().Get("X-Kin-Terminal-State"))
	}
}

func TestVerifiedStreamRejectsMissingTerminalBeforeCommit(t *testing.T) {
	anthropic := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = writer.Write([]byte("data: {\"type\":\"message_start\",\"message\":{}}\n\n"))
	}))
	defer anthropic.Close()
	worker := testServer(t, anthropic.URL)
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/messages", bytes.NewReader(messageEnvelope(true, "verified")))
	recorder := httptest.NewRecorder()
	worker.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "message_stop") {
		t.Fatalf("body=%s, want terminal error", recorder.Body.String())
	}
}

func TestRealtimeStreamReportsVerifiedTrailer(t *testing.T) {
	anthropic := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = writer.Write([]byte(
			"data: {\"type\":\"message_start\",\"message\":{}}\n\n" +
				"data: {\"type\":\"message_stop\"}\n\n",
		))
	}))
	defer anthropic.Close()
	worker := testServer(t, anthropic.URL)
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/messages", bytes.NewReader(messageEnvelope(true, "realtime")))
	recorder := httptest.NewRecorder()
	worker.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "message_stop") {
		t.Fatalf("stream body=%s", recorder.Body.String())
	}
	result := recorder.Result()
	if result.Trailer.Get("X-Kin-Terminal-State") != "verified" {
		t.Fatalf("terminal trailer=%q headers=%v", result.Trailer.Get("X-Kin-Terminal-State"), result.Header)
	}
}

func TestProxyRequiredFailsWithoutProxy(t *testing.T) {
	if _, err := upstream.NewHTTPClient("", true, time.Second); err == nil {
		t.Fatal("proxy-required client accepted empty proxy")
	}
}

func testServer(t *testing.T, base string) *Server {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	store := credential.NewStore(path)
	if _, err := store.Save(credential.Credential{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	httpClient, err := upstream.NewHTTPClient("", false, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	baseURL, _ := url.Parse(base)
	client := &upstream.Client{HTTP: httpClient, Store: store, AnthropicBase: baseURL}
	return &Server{
		Config: config.Config{
			VMID:             "vm-test",
			InternalToken:    "",
			MaxRequestBytes:  1 << 20,
			MaxResponseBytes: 1 << 20,
			MaxEventBytes:    1 << 20,
			FirstByteTimeout: time.Second,
			IdleTimeout:      time.Second,
			DeliveryMode:     "realtime",
		},
		Store:    store,
		Upstream: client,
	}
}

func messageEnvelope(stream bool, delivery string) []byte {
	payload := map[string]any{
		"body": map[string]any{
			"model":      "claude-test",
			"max_tokens": 8,
			"stream":     stream,
			"messages":   []map[string]any{{"role": "user", "content": "hi"}},
		},
		"headers":       map[string]string{"user-agent": "claude-cli/test"},
		"stream":        stream,
		"delivery_mode": delivery,
	}
	data, _ := json.Marshal(payload)
	return data
}

func TestBackgroundRefreshStopsWithContext(t *testing.T) {
	server := &Server{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	server.StartBackgroundRefresh(ctx)
}
