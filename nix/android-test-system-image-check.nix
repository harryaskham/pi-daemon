{
  pkgs,
  image,
  contract,
}: let
  apiLevel = toString contract.apiLevel;
  imageRoot = "${image}/libexec/android-sdk/${contract.directory}";
in
  pkgs.runCommand "pi-droid-android-${apiLevel}-${contract.imageType}-${contract.abi}-closure" {} ''
    test -d '${imageRoot}'
    test -f '${imageRoot}/source.properties'
    test -f '${imageRoot}/package.xml'
    grep -Fqx 'AndroidVersion.ApiLevel=${apiLevel}' '${imageRoot}/source.properties'
    grep -Fqx 'SystemImage.Abi=${contract.abi}' '${imageRoot}/source.properties'
    grep -Fqx 'SystemImage.TagId=${contract.imageType}' '${imageRoot}/source.properties'
    grep -Fq '<localPackage path="${contract.package}"' '${imageRoot}/package.xml'

    mkdir -p "$out"
    printf '%s\n' \
      'package=${contract.package}' \
      'device_profile=${contract.deviceProfile}' \
      'google_apis_required=${pkgs.lib.boolToString contract.googleApisRequired}' \
      'google_play_services_required=${pkgs.lib.boolToString contract.googlePlayServicesRequired}' \
      > "$out/contract"
  ''
