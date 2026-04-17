package rest

import (
	_ "embed"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

//go:embed openapi.yaml
var openAPISpec []byte

// swaggerHTML is the minimal Swagger UI page — loads the spec from
// /api/v1/openapi.yaml and renders the Try-It console. Using the CDN-hosted
// bundle keeps us from checking Swagger UI's 1.5MB of assets into the repo;
// offline builds can swap this for a bundled copy.
const swaggerHTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>clearvoiance API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/v1/openapi.yaml',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      persistAuthorization: true,
    });
  </script>
</body>
</html>`

// MountOpenAPI wires /docs (Swagger UI) and /api/v1/openapi.yaml|json.
func MountOpenAPI(r chi.Router, version string) {
	r.Get("/docs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(swaggerHTML))
	})
	r.Get("/api/v1/openapi.yaml", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/yaml")
		// Inject the live engine version into the spec's info.version so the
		// UI shows the right one instead of a stale literal.
		spec := strings.ReplaceAll(string(openAPISpec), "${ENGINE_VERSION}", version)
		_, _ = w.Write([]byte(spec))
	})
	r.Get("/api/v1/openapi.json", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/api/v1/openapi.yaml", http.StatusFound)
	})
}
