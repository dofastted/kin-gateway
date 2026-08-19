package stream

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestPumpRequiresTerminalEvent(t *testing.T) {
	body := io.NopCloser(strings.NewReader(
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2}}}\n\n" +
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	))
	var seen []string
	result, err := Pump(context.Background(), body, Options{}, func(event Event) error {
		seen = append(seen, event.Type)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.SawStart || !result.SawTerminal || result.EventCount != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if strings.Join(seen, ",") != "message_start,message_stop" {
		t.Fatalf("events = %v", seen)
	}
}

func TestPumpRejectsMissingMessageStop(t *testing.T) {
	body := io.NopCloser(strings.NewReader(
		"data: {\"type\":\"message_start\",\"message\":{}}\n\n" +
			"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}\n\n",
	))
	result, err := Pump(context.Background(), body, Options{}, nil)
	if err == nil || !strings.Contains(err.Error(), "message_stop") {
		t.Fatalf("result=%#v err=%v, want missing message_stop", result, err)
	}
}

func TestPumpRejectsEventAfterTerminal(t *testing.T) {
	body := io.NopCloser(strings.NewReader(
		"data: {\"type\":\"message_start\",\"message\":{}}\n\n" +
			"data: {\"type\":\"message_stop\"}\n\n" +
			"data: {\"type\":\"ping\"}\n\n",
	))
	_, err := Pump(context.Background(), body, Options{}, nil)
	if err == nil || !strings.Contains(err.Error(), "after message_stop") {
		t.Fatalf("err=%v, want event-after-terminal error", err)
	}
}

func TestPumpHonorsFirstByteTimeout(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	start := time.Now()
	_, err := Pump(context.Background(), reader, Options{
		FirstByte:     20 * time.Millisecond,
		Idle:          time.Second,
		MaxEventBytes: 1024,
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "first-byte timeout") {
		t.Fatalf("err=%v, want first-byte timeout", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("timeout took too long: %v", time.Since(start))
	}
}

func TestValidateMessageJSON(t *testing.T) {
	valid := []byte(`{"type":"message","id":"msg_1","role":"assistant","content":[]}`)
	if err := ValidateMessageJSON(valid); err != nil {
		t.Fatalf("valid message rejected: %v", err)
	}
	if err := ValidateMessageJSON([]byte(`{"type":"error"}`)); err == nil {
		t.Fatal("error payload accepted as message")
	}
}
