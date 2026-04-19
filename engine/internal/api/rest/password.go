// Argon2id password hashing for dashboard users. Encodes as the PHC
// standard string (`$argon2id$v=19$m=...,t=...,p=...$<salt_b64>$<hash_b64>`)
// so the verify step can read every parameter off the stored string — no
// side config, and rotating params doesn't invalidate old rows.
//
// OWASP 2024 minimums picked here; tuneable per deploy if a host is
// memory-constrained, but defaults should work on anything with 64 MB free.

package rest

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2idParams is the tuning surface for the KDF. Defaults hit the
// OWASP 2024 recommendation profile.
type Argon2idParams struct {
	Memory      uint32 // KiB
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// DefaultArgon2idParams are intentionally conservative — m=64MiB, t=3, p=2
// runs in well under 100ms on a modern laptop core and fits in the memory
// budget of a 512MB container.
var DefaultArgon2idParams = Argon2idParams{
	Memory:      64 * 1024,
	Iterations:  3,
	Parallelism: 2,
	SaltLength:  16,
	KeyLength:   32,
}

// ErrInvalidPasswordHash is returned by VerifyPassword when the encoded
// hash doesn't parse. Shouldn't happen for rows we wrote ourselves.
var ErrInvalidPasswordHash = errors.New("invalid password hash")

// HashPassword returns a PHC-encoded argon2id string. The caller supplies
// the plaintext; the salt is generated here from crypto/rand.
func HashPassword(plaintext string, p Argon2idParams) (string, error) {
	salt := make([]byte, p.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("read salt: %w", err)
	}
	hash := argon2.IDKey([]byte(plaintext), salt,
		p.Iterations, p.Memory, p.Parallelism, p.KeyLength)

	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Iterations, p.Parallelism,
		b64.EncodeToString(salt), b64.EncodeToString(hash)), nil
}

// VerifyPassword constant-time compares a plaintext against a stored PHC
// string. Returns (true, nil) on match, (false, nil) on mismatch,
// (false, err) only when the stored string is malformed.
func VerifyPassword(plaintext, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// Valid PHC string: ["", "argon2id", "v=19", "m=...,t=...,p=...", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidPasswordHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil ||
		version != argon2.Version {
		return false, ErrInvalidPasswordHash
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d",
		&memory, &iterations, &parallelism); err != nil {
		return false, ErrInvalidPasswordHash
	}

	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidPasswordHash
	}
	storedHash, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidPasswordHash
	}

	computed := argon2.IDKey([]byte(plaintext), salt,
		iterations, memory, parallelism, uint32(len(storedHash)))

	return subtle.ConstantTimeCompare(storedHash, computed) == 1, nil
}
