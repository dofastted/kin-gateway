package upstream

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
)

type Client struct {
	HTTP           *http.Client
	Store          *credential.Store
	Refresher      *kinoauth.Refresher
	AnthropicBase  *url.URL
	RequestTimeout time.Duration
}

type Response struct {
	Status int
	Header http.Header
	Body   io.ReadCloser
}

func NewHTTPClient(proxyURL string, proxyRequired bool, timeout time.Duration) (*http.Client, error) {
	var dialContext func(context.Context, string, string) (net.Conn, error)
	if strings.TrimSpace(proxyURL) != "" {
		dialer, err := kinproxy.New(proxyURL, 15*time.Second)
		if err != nil {
			return nil, err
		}
		dialContext = dialer.DialContext
	} else if proxyRequired {
		return nil, errors.New("slot proxy is required")
	} else {
		dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		dialContext = dialer.DialContext
	}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		MaxConnsPerHost:       32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: time.Second,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if timeout <= 0 {
		timeout = 180 * time.Second
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("upstream redirects are disabled")
		},
	}, nil
}

func (c *Client) Messages(ctx context.Context, payload json.RawMessage, headers map[string]string) (*Response, error) {
	credentialValue, err := c.ensureCredential(ctx, false)
	if err != nil {
		return nil, err
	}
	response, err := c.do(ctx, http.MethodPost, "/v1/messages", payload, headers, credentialValue.AccessToken)
	if err != nil {
		return nil, err
	}
	if response.Status != http.StatusUnauthorized {
		return response, nil
	}
	_ = response.Body.Close()
	credentialValue, err = c.ensureCredential(ctx, true)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodPost, "/v1/messages", payload, headers, credentialValue.AccessToken)
}

func (c *Client) Get(ctx context.Context, path string, headers map[string]string) (*Response, error) {
	credentialValue, err := c.ensureCredential(ctx, false)
	if err != nil {
		return nil, err
	}
	response, err := c.do(ctx, http.MethodGet, path, nil, headers, credentialValue.AccessToken)
	if err != nil {
		return nil, err
	}
	if response.Status != http.StatusUnauthorized {
		return response, nil
	}
	_ = response.Body.Close()
	credentialValue, err = c.ensureCredential(ctx, true)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodGet, path, nil, headers, credentialValue.AccessToken)
}

func (c *Client) ensureCredential(ctx context.Context, force bool) (credential.Credential, error) {
	if c.Refresher != nil {
		result, err := c.Refresher.Ensure(ctx, force)
		if err != nil {
			return credential.Credential{}, err
		}
		return result.Credential, nil
	}
	if c.Store == nil {
		return credential.Credential{}, errors.New("credential store is not configured")
	}
	current, err := c.Store.Status()
	if err != nil {
		return credential.Credential{}, err
	}
	if !current.Valid() {
		return credential.Credential{}, errors.New("credential has no access token")
	}
	return current, nil
}

func (c *Client) do(
	ctx context.Context,
	method string,
	path string,
	payload []byte,
	headers map[string]string,
	accessToken string,
) (*Response, error) {
	if c.HTTP == nil {
		return nil, errors.New("upstream HTTP client is not configured")
	}
	target, err := c.resolve(path)
	if err != nil {
		return nil, err
	}
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("build upstream request: %w", err)
	}
	for key, value := range headers {
		if !allowedHeader(key) || strings.TrimSpace(value) == "" {
			continue
		}
		request.Header.Set(key, value)
	}
	request.Header.Del("X-Api-Key")
	request.Header.Del("Cookie")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	if request.Header.Get("Content-Type") == "" && payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json")
	}
	if request.Header.Get("Anthropic-Version") == "" {
		request.Header.Set("Anthropic-Version", "2023-06-01")
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("upstream transport: %w", err)
	}
	return &Response{
		Status: response.StatusCode,
		Header: response.Header.Clone(),
		Body:   response.Body,
	}, nil
}

func (c *Client) resolve(path string) (string, error) {
	if c.AnthropicBase == nil {
		return "", errors.New("Anthropic base URL is not configured")
	}
	relative, err := url.Parse(path)
	if err != nil {
		return "", err
	}
	target := c.AnthropicBase.ResolveReference(relative)
	if !sameOrigin(c.AnthropicBase, target) {
		return "", errors.New("upstream path escaped Anthropic origin")
	}
	return target.String(), nil
}

func sameOrigin(left, right *url.URL) bool {
	if left == nil || right == nil {
		return false
	}
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		normalizedPort(left) == normalizedPort(right)
}

func normalizedPort(value *url.URL) string {
	if value.Port() != "" {
		return value.Port()
	}
	if value.Scheme == "https" {
		return "443"
	}
	return "80"
}

func allowedHeader(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "accept",
		"accept-language",
		"anthropic-beta",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-version",
		"content-type",
		"user-agent",
		"x-app",
		"x-claude-code-session-id",
		"x-client-request-id",
		"x-stainless-arch",
		"x-stainless-helper-method",
		"x-stainless-lang",
		"x-stainless-os",
		"x-stainless-package-version",
		"x-stainless-retry-count",
		"x-stainless-runtime",
		"x-stainless-runtime-version",
		"x-stainless-timeout":
		return true
	default:
		return false
	}
}
