package stream

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type Event struct {
	Raw        []byte
	Name       string
	Data       []byte
	Type       string
	Terminal   bool
	Usage      map[string]any
	Model      string
	StopReason string
}

type Result struct {
	SawStart    bool
	SawTerminal bool
	EventCount  int
	Usage       map[string]any
	Model       string
	StopReason  string
}

type Options struct {
	MaxEventBytes int
	FirstByte     time.Duration
	Idle          time.Duration
}

type state struct {
	started    bool
	terminal   bool
	count      int
	usage      map[string]any
	model      string
	stopReason string
}

func Pump(
	ctx context.Context,
	body io.ReadCloser,
	options Options,
	onEvent func(Event) error,
) (Result, error) {
	if body == nil {
		return Result{}, errors.New("stream body is nil")
	}
	defer body.Close()
	if options.MaxEventBytes <= 0 {
		options.MaxEventBytes = 32 << 20
	}
	if options.FirstByte <= 0 {
		options.FirstByte = 120 * time.Second
	}
	if options.Idle <= 0 {
		options.Idle = 180 * time.Second
	}
	events := make(chan Event, 1)
	readErrors := make(chan error, 1)
	go scan(body, options.MaxEventBytes, events, readErrors)

	tracker := &state{}
	first := true
	timer := time.NewTimer(options.FirstByte)
	defer timer.Stop()
	resetTimer := func(duration time.Duration) {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(duration)
	}
	for {
		select {
		case <-ctx.Done():
			_ = body.Close()
			return tracker.result(), ctx.Err()
		case <-timer.C:
			_ = body.Close()
			if first {
				return tracker.result(), errors.New("stream first-byte timeout")
			}
			return tracker.result(), errors.New("stream idle timeout")
		case event, ok := <-events:
			if !ok {
				events = nil
				if readErrors == nil {
					return finish(tracker)
				}
				continue
			}
			first = false
			resetTimer(options.Idle)
			if err := tracker.observe(event); err != nil {
				_ = body.Close()
				return tracker.result(), err
			}
			if onEvent != nil {
				if err := onEvent(event); err != nil {
					_ = body.Close()
					return tracker.result(), err
				}
			}
		case err, ok := <-readErrors:
			if ok && err != nil {
				return tracker.result(), err
			}
			readErrors = nil
			if events == nil {
				return finish(tracker)
			}
		}
	}
}

func finish(tracker *state) (Result, error) {
	result := tracker.result()
	if !result.SawStart {
		return result, errors.New("stream closed before message_start")
	}
	if !result.SawTerminal {
		return result, errors.New("stream closed before message_stop")
	}
	return result, nil
}

func scan(body io.Reader, maxEventBytes int, events chan<- Event, readErrors chan<- error) {
	defer close(events)
	defer close(readErrors)
	scanner := bufio.NewScanner(body)
	scanner.Split(splitSSE)
	scanner.Buffer(make([]byte, 64*1024), maxEventBytes)
	for scanner.Scan() {
		raw := append([]byte(nil), scanner.Bytes()...)
		event, err := parseEvent(raw)
		if err != nil {
			readErrors <- err
			return
		}
		events <- event
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			readErrors <- fmt.Errorf("SSE event exceeds %d bytes", maxEventBytes)
			return
		}
		readErrors <- err
	}
}

func splitSSE(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if len(data) == 0 && atEOF {
		return 0, nil, nil
	}
	normalized := bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	if index := bytes.Index(normalized, []byte("\n\n")); index >= 0 {
		// CRLF normalization can change byte offsets. Find the delimiter in the
		// original data when possible, otherwise consume the normalized token.
		if original := bytes.Index(data, []byte("\r\n\r\n")); original >= 0 && original <= index+4 {
			return original + 4, bytes.TrimSpace(data[:original]), nil
		}
		if original := bytes.Index(data, []byte("\n\n")); original >= 0 {
			return original + 2, bytes.TrimSpace(data[:original]), nil
		}
	}
	if atEOF {
		return len(data), bytes.TrimSpace(data), nil
	}
	return 0, nil, nil
}

func parseEvent(raw []byte) (Event, error) {
	event := Event{Raw: append(append([]byte(nil), raw...), '\n', '\n')}
	var dataLines []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSuffix(line, "\r")
		switch {
		case strings.HasPrefix(line, "event:"):
			event.Name = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if len(dataLines) == 0 {
		return event, nil
	}
	event.Data = []byte(strings.Join(dataLines, "\n"))
	var payload map[string]any
	if err := json.Unmarshal(event.Data, &payload); err != nil {
		return Event{}, fmt.Errorf("decode SSE data: %w", err)
	}
	event.Type, _ = payload["type"].(string)
	if event.Name == "" {
		event.Name = event.Type
	}
	event.Terminal = event.Type == "message_stop"
	if usage, ok := payload["usage"].(map[string]any); ok {
		event.Usage = usage
	}
	if message, ok := payload["message"].(map[string]any); ok {
		if usage, ok := message["usage"].(map[string]any); ok {
			event.Usage = usage
		}
		if model, ok := message["model"].(string); ok {
			event.Model = model
		}
		if reason, ok := message["stop_reason"].(string); ok && reason != "" {
			event.StopReason = reason
		}
	}
	if delta, ok := payload["delta"].(map[string]any); ok {
		if reason, ok := delta["stop_reason"].(string); ok && reason != "" {
			event.StopReason = reason
		}
	}
	return event, nil
}

func (s *state) observe(event Event) error {
	s.count++
	if s.terminal {
		return errors.New("SSE event received after message_stop")
	}
	switch event.Type {
	case "message_start":
		if s.started {
			return errors.New("duplicate message_start")
		}
		s.started = true
	case "error":
		return fmt.Errorf("upstream SSE error: %s", truncate(event.Data, 300))
	case "message_stop":
		if !s.started {
			return errors.New("message_stop before message_start")
		}
		s.terminal = true
	}
	if event.Usage != nil {
		s.usage = mergeUsage(s.usage, event.Usage)
	}
	if event.Model != "" {
		s.model = event.Model
	}
	if event.StopReason != "" {
		s.stopReason = event.StopReason
	}
	return nil
}

func (s *state) result() Result {
	return Result{
		SawStart:    s.started,
		SawTerminal: s.terminal,
		EventCount:  s.count,
		Usage:       s.usage,
		Model:       s.model,
		StopReason:  s.stopReason,
	}
}

func mergeUsage(current, next map[string]any) map[string]any {
	if current == nil {
		current = make(map[string]any)
	}
	for key, value := range next {
		current[key] = value
	}
	return current
}

func ValidateMessageJSON(data []byte) error {
	var payload struct {
		Type    string          `json:"type"`
		ID      string          `json:"id"`
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("decode Anthropic response: %w", err)
	}
	if payload.Type != "message" {
		return fmt.Errorf("unexpected Anthropic response type %q", payload.Type)
	}
	if payload.ID == "" || payload.Role != "assistant" || len(payload.Content) == 0 {
		return errors.New("Anthropic message response is incomplete")
	}
	return nil
}

func truncate(data []byte, max int) string {
	if len(data) <= max {
		return string(data)
	}
	return string(data[:max])
}
