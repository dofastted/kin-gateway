package credential

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestStorePreservesUnknownFieldsAndRotatesGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	seed := map[string]any{
		"unknownTop": "keep",
		"claudeAiOauth": map[string]any{
			"accessToken":   "old-access",
			"refreshToken":  "old-refresh",
			"expiresAt":     time.Now().Add(time.Hour).UnixMilli(),
			"unknownOAuth":  "keep-too",
			"kinGeneration": float64(10),
		},
	}
	data, _ := json.Marshal(seed)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	current, document, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	current.AccessToken = "new-access"
	current.RefreshToken = "new-refresh"
	saved, err := store.Save(current, document)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Generation <= 10 {
		t.Fatalf("generation = %d, want > 10", saved.Generation)
	}
	_, decoded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if decoded["unknownTop"] != "keep" {
		t.Fatalf("unknown top-level field was lost: %#v", decoded)
	}
	oauth := decoded["claudeAiOauth"].(map[string]any)
	if oauth["unknownOAuth"] != "keep-too" {
		t.Fatalf("unknown OAuth field was lost: %#v", oauth)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode = %o, want 600", info.Mode().Perm())
	}
}

func TestStoreLockSerializesWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	var (
		mu      sync.Mutex
		active  int
		maxSeen int
	)
	run := func() error {
		return store.WithLock(context.Background(), func() error {
			mu.Lock()
			active++
			if active > maxSeen {
				maxSeen = active
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			active--
			mu.Unlock()
			return nil
		})
	}
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := run(); err != nil {
				t.Errorf("WithLock: %v", err)
			}
		}()
	}
	wg.Wait()
	if maxSeen != 1 {
		t.Fatalf("max concurrent lock holders = %d, want 1", maxSeen)
	}
}
