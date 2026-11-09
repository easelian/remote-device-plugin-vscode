const path = require('node:path');

function localization(language = 'en') {
  const bundle = ['zh-cn', 'zh-tw'].includes(language)
    ? require(path.join('../../l10n', `bundle.l10n.${language}.json`))
    : {};
  return {
    t(message, ...args) {
      return (bundle[message] ?? message).replace(/\{(\d+)\}/g, (_, index) => String(args[index]));
    },
  };
}

module.exports = { localization };
