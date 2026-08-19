package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func TestEnsureDeduplicatesConcurrentRefresh(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		time.Sleep(30 * time.Millisecond)
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode refresh body: %v", err)
		}
		if body["refresh_token"] != "refresh-1" || body["grant_type"] != "refresh_token" {
			t.Errorf("unexpected refresh body: %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800,"scope":"user:inference"}`))
	}))
	defer upstream.Close()

	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{
		Store:    store,
		Client:   upstream.Client(),
		TokenURL: upstream.URL,
		Skew:     5 * time.Minute,
		MaxTries: 1,
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := refresher.Ensure(context.Background(), false)
			if err != nil {
				t.Errorf("Ensure: %v", err)
				return
			}
			if result.Credential.AccessToken != "access-2" {
				t.Errorf("access token = %q", result.Credential.AccessToken)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", calls.Load())
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.RefreshToken != "refresh-2" || current.AccessToken != "access-2" {
		t.Fatalf("stored credential = %#v", current)
	}
}

func TestEnsureDoesNotPersistAfterCancellation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		time.Sleep(100 * time.Millisecond)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"too-late","refresh_token":"too-late","expires_in":28800}`))
	}))
	defer upstream.Close()
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	original, err := store.Save(credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err = refresher.Ensure(ctx, true); err == nil {
		t.Fatal("expected cancellation error")
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation != original.Generation || current.AccessToken != original.AccessToken {
		t.Fatalf("credential changed after cancellation: before=%#v after=%#v", original, current)
	}
}
