//go:build integration

// Run with: `go test -tags=integration ./engine/internal/storage/blob/...`

package blob

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/stretchr/testify/require"
	tcminio "github.com/testcontainers/testcontainers-go/modules/minio"
)

const (
	testUser   = "dev"
	testSecret = "devdevdev"
	testBucket = "test-blobs"
)

func TestS3_PresignPut_RoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	container, err := tcminio.Run(ctx, "minio/minio:RELEASE.2024-12-18T13-15-44Z",
		tcminio.WithUsername(testUser),
		tcminio.WithPassword(testSecret),
	)
	require.NoError(t, err)
	t.Cleanup(func() {
		if err := container.Terminate(ctx); err != nil {
			t.Logf("terminate minio: %v", err)
		}
	})

	endpoint, err := container.ConnectionString(ctx)
	require.NoError(t, err)
	endpointURL := "http://" + endpoint

	// Provision the bucket via the real SDK before presigning against it.
	adminCfg := s3.Options{
		Region:       "us-east-1",
		UsePathStyle: true,
		Credentials:  credentials.NewStaticCredentialsProvider(testUser, testSecret, ""),
		BaseEndpoint: aws.String(endpointURL),
	}
	admin := s3.New(adminCfg)
	_, err = admin.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(testBucket)})
	require.NoError(t, err)

	// Now exercise our Store.
	store, err := OpenS3(S3Config{
		Endpoint:     endpointURL,
		Region:       "us-east-1",
		AccessKey:    testUser,
		SecretKey:    testSecret,
		Bucket:       testBucket,
		UsePathStyle: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	payload := []byte("hello blob world")
	sha := "a0e6b18f5f0d3a92b3cff6c3a0c7eb0d0c0d0c0d0c0d0c0d0c0d0c0d0c0d0c0d"
	presigned, err := store.PresignPut(ctx, PresignPutRequest{
		SessionID:   "sess_test",
		SHA256:      sha,
		SizeBytes:   int64(len(payload)),
		ContentType: "text/plain",
	})
	require.NoError(t, err)
	require.NotEmpty(t, presigned.UploadURL)
	require.Equal(t, testBucket, presigned.Bucket)
	require.True(t, strings.Contains(presigned.Key, sha))

	// PUT via the presigned URL, replicating what the SDK will do.
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, presigned.UploadURL, bytes.NewReader(payload))
	require.NoError(t, err)
	for k, v := range presigned.RequiredHeaders {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	bodyBytes, _ := io.ReadAll(resp.Body)
	require.NoError(t, resp.Body.Close())
	require.True(t, resp.StatusCode >= 200 && resp.StatusCode < 300,
		"PUT expected 2xx, got %d: %s", resp.StatusCode, string(bodyBytes))

	// Verify via HEAD / GetObject.
	got, err := admin.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(presigned.Bucket),
		Key:    aws.String(presigned.Key),
	})
	require.NoError(t, err)
	read, err := io.ReadAll(got.Body)
	require.NoError(t, err)
	require.NoError(t, got.Body.Close())
	require.Equal(t, payload, read, "fetched body must match uploaded")

	// Dedup: a second PresignPut for the same session+sha256 must now report
	// AlreadyExists=true and NOT issue a fresh upload URL, so SDKs skip the PUT.
	dup, err := store.PresignPut(ctx, PresignPutRequest{
		SessionID:   "sess_test",
		SHA256:      sha,
		SizeBytes:   int64(len(payload)),
		ContentType: "text/plain",
	})
	require.NoError(t, err)
	require.True(t, dup.AlreadyExists, "second PresignPut for same key must set AlreadyExists")
	require.Empty(t, dup.UploadURL, "AlreadyExists response must not return an upload URL")
	require.Equal(t, presigned.Key, dup.Key)
}

func TestS3_PresignPut_RejectsMissingFields(t *testing.T) {
	store, err := OpenS3(S3Config{
		Endpoint:     "http://localhost:9",
		Region:       "us-east-1",
		AccessKey:    "k",
		SecretKey:    "s",
		Bucket:       "b",
		UsePathStyle: true,
	})
	require.NoError(t, err)

	_, err = store.PresignPut(context.Background(), PresignPutRequest{SHA256: "abc"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "session_id and sha256 are required")

	_, err = store.PresignPut(context.Background(), PresignPutRequest{SessionID: "s"})
	require.Error(t, err)
}

func TestNoop_AlwaysErrors(t *testing.T) {
	var n Noop
	_, err := n.PresignPut(context.Background(), PresignPutRequest{
		SessionID: "s", SHA256: "h", SizeBytes: 1,
	})
	require.ErrorIs(t, err, ErrBlobNotConfigured)
	require.NoError(t, n.Close())
	_ = fmt.Sprint("satisfy fmt import")
}
