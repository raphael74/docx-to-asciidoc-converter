#!/bin/sh
# Renders the AsciiDoc assembly (read from stdin) to PDF with Asciidoctor PDF
# from the official Asciidoctor container. This keeps Ruby off the host and is
# what antora-assembler-pdf.yml uses by default.
#
# The container runs as the host user and mounts the project directory, so the
# generated PDFs are owned by the person running the build. That matters because
# Assembler cleans build/pdf before each run and overwrites the export files.
set -eu

exec docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --workdir "$PWD" \
  --volume "$PWD:$PWD" \
  asciidoctor/docker-asciidoctor \
  asciidoctor-pdf "$@"
