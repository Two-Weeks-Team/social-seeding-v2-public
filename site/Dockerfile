# Static site server for the Social Seeding v2 live demo landing.
# Cites: D29 (3-angle differentiation), D30 (live demo distribution), D39 (GCP $1500 envelope).
#
# Cloud Run expects the container to listen on $PORT (default 8080). nginx default is 80,
# so we rewrite the default config to 8080 at build time.

FROM nginx:1.27-alpine

# Copy all static assets (index.html, demo/, report/, favicon.svg).
COPY . /usr/share/nginx/html/

# Remove build-time artifacts that should not be served.
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/.nojekyll

# Rewrite nginx to listen on 8080 (Cloud Run convention).
RUN sed -i 's/listen       80;/listen 8080;/g' /etc/nginx/conf.d/default.conf \
 && sed -i 's/listen  \[::\]:80;/listen [::]:8080;/g' /etc/nginx/conf.d/default.conf || true

# Healthcheck path — nginx serves index.html on /.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/ || exit 1

# Non-root user is the default in nginx:alpine 1.25+ (nginx user, uid 101).
EXPOSE 8080

# Default CMD inherits from nginx base image: nginx -g "daemon off;"
