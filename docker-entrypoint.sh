#!/bin/sh

# Generate runtime-config.js with environment variables from Cloud Run.
# Only Firebase config is needed — no Gemini key since the access site
# never calls Gemini.
cat > /usr/share/nginx/html/runtime-config.js <<EOF
// Runtime configuration generated at container startup
window.__RUNTIME_CONFIG__ = {
  FIREBASE_API_KEY: '${FIREBASE_API_KEY}',
  FIREBASE_AUTH_DOMAIN: '${FIREBASE_AUTH_DOMAIN}',
  FIREBASE_PROJECT_ID: '${FIREBASE_PROJECT_ID}',
  FIREBASE_STORAGE_BUCKET: '${FIREBASE_STORAGE_BUCKET}',
  FIREBASE_MESSAGING_SENDER_ID: '${FIREBASE_MESSAGING_SENDER_ID}',
  FIREBASE_APP_ID: '${FIREBASE_APP_ID}'
};
EOF

echo "Runtime configuration generated with environment variables"
cat /usr/share/nginx/html/runtime-config.js

# Start nginx
exec nginx -g 'daemon off;'
