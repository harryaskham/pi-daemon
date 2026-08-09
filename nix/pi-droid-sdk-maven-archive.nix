{
  pkgs,
  repository,
  version,
}: let
  archiveName = "pi-droid-sdk-maven-${version}";
in
  assert builtins.match "[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?" version != null;
    pkgs.runCommand "${archiveName}-archive" {
      src = repository;
      nativeBuildInputs = [pkgs.coreutils pkgs.findutils pkgs.gnutar pkgs.gzip pkgs.jq];
    } ''
      set -euo pipefail
      provenance="$src/metadata/provenance.json"
      if [ ! -f "$provenance" ] || [ "$(wc -c < "$provenance")" -gt 65536 ]; then
        printf '%s\n' 'Pi Droid SDK repository provenance is missing or oversized' >&2
        exit 1
      fi
      repository_version="$(jq -er 'if (.version | type) == "string" then .version else error("invalid version") end' "$provenance")"
      if [ "$repository_version" != "${version}" ]; then
        printf '%s\n' 'Pi Droid SDK repository version does not match canonical publication version' >&2
        exit 1
      fi

      work="$TMPDIR/${archiveName}"
      mkdir -p "$work" "$out/repository"
      cp -R --no-preserve=mode,ownership,timestamps "$src"/. "$work"/
      find "$work" -exec touch -h -d '@1' {} +

      cp -R --no-preserve=mode,ownership,timestamps "$work"/. "$out/repository"/
      find "$out/repository" -exec touch -h -d '@1' {} +

      tar \
        --sort=name \
        --mtime='@1' \
        --owner=0 \
        --group=0 \
        --numeric-owner \
        --format=ustar \
        -C "$TMPDIR" \
        -cf - \
        "${archiveName}" \
        | gzip -n -9 > "$out/${archiveName}.tar.gz"
      sha256sum "$out/${archiveName}.tar.gz" \
        | sed "s#$out/##" > "$out/${archiveName}.tar.gz.sha256"
    ''
