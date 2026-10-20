#!/usr/bin/env bash
#
# Converts all .docx files from the source folder to AsciiDoc format using
# pandoc. Each document gets its own folder in the destination folder that
# contains the .adoc file and its extracted media.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/source"
DEST_DIR="${SCRIPT_DIR}/destination"

if ! command -v pandoc &>/dev/null; then
    echo "Error: pandoc is not installed or not on the PATH." >&2
    exit 1
fi

if [[ ! -d "${SOURCE_DIR}" ]]; then
    echo "Error: source directory not found: ${SOURCE_DIR}" >&2
    exit 1
fi

rm -rf ${DEST_DIR}

# Make the glob expand to nothing (instead of the literal pattern) if there
# are no matches. Also match extensions case-insensitively (.docx, .DOCX).
shopt -s nullglob nocaseglob
INPUT_FILES=("${SOURCE_DIR}"/*.docx)
shopt -u nocaseglob

if [[ ${#INPUT_FILES[@]} -eq 0 ]]; then
    echo "Error: no .docx files found in ${SOURCE_DIR}" >&2
    exit 1
fi

for INPUT_FILE in "${INPUT_FILES[@]}"; do
    BASENAME="$(basename "${INPUT_FILE}")"
    NAME="${BASENAME%.*}"
    DOC_DIR="${DEST_DIR}/${NAME}"
    OUTPUT_FILE="${DOC_DIR}/${NAME}.adoc"

    mkdir -p "${DOC_DIR}"

    echo "Converting ${INPUT_FILE} to ${OUTPUT_FILE} ..."
    # Run pandoc from the document folder so that the image references
    # written to the .adoc file stay relative to it (media/image1.png, ...).
    (
        cd "${DOC_DIR}"
        pandoc --from docx --to asciidoc --wrap=none \
            --extract-media . \
            --output "${NAME}.adoc" \
            "${INPUT_FILE}"
    )
    echo "Done: ${OUTPUT_FILE}"
done

echo "Converted ${#INPUT_FILES[@]} file(s)."