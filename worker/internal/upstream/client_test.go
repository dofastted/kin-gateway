package upstream

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	kinproxy "github.com/dofastted/kin-gateway/worker/internal/proxy"
)

func TestRefreshAndMessagesUseSameSOCKSProxy(t *testing.T) {
	var pathsMu sync.Mutex
	var paths []string
	anthropic := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		pathsMu.Lock()
		paths = append(paths, request.URL.Path)
		pathsMu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/oauth/token" {
			_, _ = writer.Write([]byte(`{"access_token":"access-new","refresh_token":"refresh-new","expires_in":28800}`))
			return
		}
		if request.Header.Get("Authorization") != "Bearer access-new" {
			t.Errorf("messages authorization = %q", request.Header.Get("Authorization"))
		}
		_, _ = writer.Write([]byte(`{"type":"message","id":"msg_1","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer anthropic.Close()

	proxyURL, proxyConnections, closeProxy := startRelaySOCKS(t)
	defer closeProxy()
	dialer, err := kinproxy.New(proxyURL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{DialContext: dialer.DialContext}
	httpClient := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err = store.Save(credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &kinoauth.Refresher{
		Store:    store,
		Client:   httpClient,
		TokenURL: anthropic.URL + "/oauth/token",
		MaxTries: 1,
	}
	base, _ := url.Parse(anthropic.URL)
	client := &Client{
		HTTP:          httpClient,
		Store:         store,
		Refresher:     refresher,
		AnthropicBase: base,
	}
	body, _ := json.Marshal(map[string]any{
		"model":    "claude-test",
		"messages": []map[string]any{{"role": "user", "content": "hi"}},
	})
	response, err := client.Messages(context.Background(), body, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	pathsMu.Lock()
	gotPaths := append([]string(nil), paths...)
	pathsMu.Unlock()
	if len(gotPaths) != 2 || gotPaths[0] != "/oauth/token" || gotPaths[1] != "/v1/messages" {
		t.Fatalf("upstream paths = %v", gotPaths)
	}
	if proxyConnections.Load() == 0 {
		t.Fatal("refresh/messages bypassed SOCKS proxy")
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.AccessToken != "access-new" || current.RefreshToken != "refresh-new" {
		t.Fatalf("credential did not rotate: %#v", current)
	}
}

func TestOAuthTransportNeverAllowsDirectFallback(t *testing.T) {
	if _, err := NewOAuthHTTPClient("", false, time.Second); err == nil {
		t.Fatal("OAuth client allowed direct transport without slot SOCKS5")
	}
}

func TestInferenceTransportRequiresSlotSOCKSWhenProxyRequired(t *testing.T) {
	if _, err := NewHTTPClient("", true, time.Second); err == nil {
		t.Fatal("inference client allowed missing SOCKS when proxy_required")
	}
}

func TestInferenceAndOAuthClientsAreDistinct(t *testing.T) {
	proxyURL, _, closeProxy := startRelaySOCKS(t)
	defer closeProxy()
	infer, err := NewHTTPClient(proxyURL, true, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	oauth, err := NewOAuthHTTPClient(proxyURL, true, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if infer.Transport == nil || oauth.Transport == nil {
		t.Fatal("missing transport")
	}
	if infer.Transport == oauth.Transport {
		t.Fatal("inference and OAuth share a transport")
	}
}

func startRelaySOCKS(t *testing.T) (string, *atomic.Int32, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var connections atomic.Int32
	done := make(chan struct{})
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			connections.Add(1)
			go relaySOCKSConnection(conn, done)
		}
	}()
	return "socks5h://" + listener.Addr().String(), &connections, func() {
		close(done)
		_ = listener.Close()
	}
}

func relaySOCKSConnection(client net.Conn, done <-chan struct{}) {
	defer client.Close()
	head := make([]byte, 2)
	if _, err := io.ReadFull(client, head); err != nil {
		return
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return
	}
	_, _ = client.Write([]byte{0x05, 0x00})
	requestHead := make([]byte, 4)
	if _, err := io.ReadFull(client, requestHead); err != nil {
		return
	}
	var host string
	switch requestHead[3] {
	case 0x01:
		raw := make([]byte, 4)
		_, _ = io.ReadFull(client, raw)
		host = net.IP(raw).String()
	case 0x03:
		length := make([]byte, 1)
		_, _ = io.ReadFull(client, length)
		raw := make([]byte, int(length[0]))
		_, _ = io.ReadFull(client, raw)
		host = string(raw)
	default:
		return
	}
	portRaw := make([]byte, 2)
	_, _ = io.ReadFull(client, portRaw)
	target := net.JoinHostPort(host, uint16String(binary.BigEndian.Uint16(portRaw)))
	upstreamConn, err := net.DialTimeout("tcp", target, time.Second)
	if err != nil {
		_, _ = client.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer upstreamConn.Close()
	_, _ = client.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 1})
	go io.Copy(upstreamConn, client)
	finished := make(chan struct{})
	go func() {
		_, _ = io.Copy(client, upstreamConn)
		close(finished)
	}()
	select {
	case <-finished:
	case <-done:
	}
}

func uint16String(value uint16) string {
	if value == 0 {
		return "0"
	}
	var buffer [5]byte
	index := len(buffer)
	number := int(value)
	for number > 0 {
		index--
		buffer[index] = byte('0' + number%10)
		number /= 10
	}
	return string(buffer[index:])
}
