// Expo config-plugin: laat de 'fmt'-library (meegebracht door React Native 0.79)
// compileren onder Xcode 26. Xcode 26's clang is strenger op `consteval`
// ("not a constant expression"); FMT_USE_CONSTEVAL=0 schakelt dat pad uit
// (fmt valt terug op constexpr). Injecteert een GCC_PREPROCESSOR_DEFINITIONS in
// de Podfile-post_install voor alle pod-targets.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const INJECT = `
    installer.pods_project.targets.each do |__t|
      __t.build_configurations.each do |__bc|
        __bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
        __bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'FMT_USE_CONSTEVAL=0'
        __bc.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'FMT_CONSTEVAL=constexpr'
        __existing = __bc.build_settings['OTHER_CPLUSPLUSFLAGS'] || ['$(inherited)']
        __existing = [__existing] unless __existing.is_a?(Array)
        __bc.build_settings['OTHER_CPLUSPLUSFLAGS'] = __existing + ['-DFMT_USE_CONSTEVAL=0', '-DFMT_CONSTEVAL=constexpr']
      end
    end`;

module.exports = function withFmtFix(config) {
  return withDangerousMod(config, ['ios', async (cfg) => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
    let contents = fs.readFileSync(podfile, 'utf8');
    if (!contents.includes('FMT_USE_CONSTEVAL=0')) {
      contents = contents.replace(/post_install do \|installer\|/, `post_install do |installer|${INJECT}`);
      fs.writeFileSync(podfile, contents);
    }
    return cfg;
  }]);
};
