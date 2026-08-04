{
  pkgs,
  repository,
  version ? "0.3.0-alpha.1",
}: let
  archiveName = "pi-droid-sdk-maven-${version}";
in
  pkgs.runCommand "${archiveName}-archive" {
    src = repository;
    nativeBuildInputs = [pkgs.coreutils pkgs.findutils pkgs.gnutar pkgs.gzip];
  } ''
    set -euo pipefail
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
