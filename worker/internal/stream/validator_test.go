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

func TestPumpCapturesUsageModelStopReason(t *testing.T) {
	body := io.NopCloser(strings.NewReader(
		"data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\"," +
			"\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":3,\"cache_creation_input_tokens\":5," +
			"\"cache_creation\":{\"ephemeral_5m_input_tokens\":5,\"ephemeral_1h_input_tokens\":0}}}}\n\n" +
			"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n" +
			"data: {\"type\":\"message_stop\"}\n\n",
	))
	result, err := Pump(context.Background(), body, Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != "claude-haiku-4-5-20251001" {
		t.Fatalf("model=%q", result.Model)
	}
	if result.StopReason != "end_turn" {
		t.Fatalf("stop_reason=%q", result.StopReason)
	}
	if got := result.Usage["input_tokens"]; got != float64(12) {
		t.Fatalf("input_tokens=%v", got)
	}
	if got := result.Usage["output_tokens"]; got != float64(4) {
		t.Fatalf("output_tokens=%v (message_delta usage must merge)", got)
	}
	if got := result.Usage["cache_read_input_tokens"]; got != float64(3) {
		t.Fatalf("cache_read_input_tokens=%v", got)
	}
	nested, ok := result.Usage["cache_creation"].(map[string]any)
	if !ok || nested["ephemeral_5m_input_tokens"] != float64(5) {
		t.Fatalf("cache_creation breakdown=%v", result.Usage["cache_creation"])
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
