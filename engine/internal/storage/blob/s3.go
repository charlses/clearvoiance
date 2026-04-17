// S3-compatible blob store. Works against AWS S3, MinIO, R2, GCS in S3 mode,
// etc. — anything that speaks presigned-URL PUTs.

package blob

import (
	"context"
	"fmt"
	"io"
	"path"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Config configures an S3-compatible blob store.
type S3Config struct {
	// Endpoint is the full URL of the S3 service (e.g. "http://minio:9000").
	// Leave empty to use the AWS default (real S3).
	Endpoint string

	// Region is required; "us-east-1" is a safe default for MinIO + self-host.
	Region string

	// AccessKey / SecretKey. For production AWS, prefer IAM role auth by
	// leaving these empty and setting up the default credential chain.
	AccessKey string
	SecretKey string

	// Bucket is the bucket all blobs land in. Must exist — the engine does
	// not create buckets automatically; operators provision them with the
	// policy they want.
	Bucket string

	// UsePathStyle forces path-style addressing (`endpoint/bucket/key`) instead
	// of virtual-hosted-style. Required for MinIO and many self-host setups.
	UsePathStyle bool

	// PresignExpiry caps how long a PUT URL is valid. Defaults to 10 minutes.
	PresignExpiry time.Duration
}

// S3 is a Store backed by S3-compatible object storage.
type S3 struct {
	client  *s3.Client
	bucket  string
	presign *s3.PresignClient
	expiry  time.Duration
}

// OpenS3 constructs a Store from S3Config. Does NOT ping the backend —
// presign is local. Use HeadBucket to verify connectivity during startup
// if you want fail-fast behavior.
func OpenS3(cfg S3Config) (*S3, error) {
	if cfg.Bucket == "" {
		return nil, fmt.Errorf("blob: bucket is required")
	}
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	if cfg.PresignExpiry == 0 {
		cfg.PresignExpiry = 10 * time.Minute
	}

	opts := s3.Options{
		Region:       cfg.Region,
		UsePathStyle: cfg.UsePathStyle,
	}
	if cfg.AccessKey != "" {
		opts.Credentials = credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, "")
	}
	if cfg.Endpoint != "" {
		opts.BaseEndpoint = aws.String(cfg.Endpoint)
	}

	client := s3.New(opts)
	return &S3{
		client:  client,
		bucket:  cfg.Bucket,
		presign: s3.NewPresignClient(client),
		expiry:  cfg.PresignExpiry,
	}, nil
}

// PresignPut returns a PUT URL for the session-scoped, sha256-keyed object.
// Performs a HEAD first so SDKs can skip re-uploading bodies that already
// exist (natural dedup: same sha256 → same key). The `already_exists` field
// on the returned result lets the SDK know.
func (s *S3) PresignPut(ctx context.Context, req PresignPutRequest) (*PresignPutResult, error) {
	if req.SessionID == "" || req.SHA256 == "" {
		return nil, fmt.Errorf("blob: session_id and sha256 are required")
	}

	key := path.Join("sessions", req.SessionID, "blobs", req.SHA256)

	// Dedup check. A successful HEAD means the blob is already uploaded for
	// this session + sha256 combo; return an AlreadyExists result with an
	// empty upload URL so the SDK skips the PUT entirely.
	if _, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}); err == nil {
		return &PresignPutResult{
			Bucket:        s.bucket,
			Key:           key,
			AlreadyExists: true,
		}, nil
	}
	// Any HEAD error (including 404) falls through to presign a fresh upload.
	putInput := &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(key),
		ContentLength: aws.Int64(req.SizeBytes),
	}
	if req.ContentType != "" {
		putInput.ContentType = aws.String(req.ContentType)
	}

	signed, err := s.presign.PresignPutObject(ctx, putInput, func(o *s3.PresignOptions) {
		o.Expires = s.expiry
	})
	if err != nil {
		return nil, fmt.Errorf("blob: presign put: %w", err)
	}

	// AWS SDK signs a handful of headers (Content-Length, Host at minimum).
	// The SDK side must echo those exactly on the PUT or S3 rejects the
	// request, so we forward them.
	required := make(map[string]string, len(signed.SignedHeader))
	for name, vs := range signed.SignedHeader {
		if len(vs) > 0 {
			required[name] = vs[0]
		}
	}

	return &PresignPutResult{
		UploadURL:       signed.URL,
		Bucket:          s.bucket,
		Key:             key,
		RequiredHeaders: required,
		ExpiresAt:       time.Now().Add(s.expiry),
	}, nil
}

// Get fetches a blob's bytes. Used by replay to rehydrate BlobRef bodies.
func (s *S3) Get(ctx context.Context, bucket, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("blob get %s/%s: %w", bucket, key, err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

// Close is a no-op for S3 — the client is stateless, no connections to drain.
func (*S3) Close() error { return nil }
