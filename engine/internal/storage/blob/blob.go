// Package blob is the boundary between the engine and object storage for
// large event bodies.
//
// SDKs don't upload bodies through the engine — that would force every byte
// to traverse gRPC. Instead, the engine issues time-limited presigned PUT
// URLs and the SDK uploads directly to the blob store. See plan/04 for the
// full GetBlobUploadURL flow.
package blob

import (
	"context"
	"errors"
	"time"
)

// PresignPutRequest is what a caller needs to upload one object.
type PresignPutRequest struct {
	SessionID   string
	SHA256      string
	SizeBytes   int64
	ContentType string
}

// PresignPutResult is what the SDK receives to perform the PUT.
type PresignPutResult struct {
	UploadURL       string
	Bucket          string
	Key             string
	RequiredHeaders map[string]string
	ExpiresAt       time.Time
}

// ErrBlobNotConfigured is returned by the Noop store to signal that no blob
// backend is wired up; callers should fall back to inline-or-truncate.
var ErrBlobNotConfigured = errors.New("blob storage not configured")

// Store abstracts object storage. Capture issues presigned PUT URLs; replay
// fetches bodies back via Get.
type Store interface {
	// PresignPut returns a URL (plus any required headers) the SDK must PUT
	// the body to.
	PresignPut(ctx context.Context, req PresignPutRequest) (*PresignPutResult, error)

	// Get reads a previously-uploaded blob. Used by the replay dispatcher
	// when a captured body is a BlobRef instead of inline bytes.
	Get(ctx context.Context, bucket, key string) ([]byte, error)

	// Close releases the underlying client.
	Close() error
}

// Noop always returns ErrBlobNotConfigured. Used in dev when no --minio-* flags
// are set; adapters gracefully fall back to inline-or-truncate.
type Noop struct{}

// PresignPut always errors.
func (Noop) PresignPut(_ context.Context, _ PresignPutRequest) (*PresignPutResult, error) {
	return nil, ErrBlobNotConfigured
}

// Get always errors. Replay dispatcher should skip BlobRef bodies when hit.
func (Noop) Get(_ context.Context, _, _ string) ([]byte, error) {
	return nil, ErrBlobNotConfigured
}

// Close is a no-op.
func (Noop) Close() error { return nil }
