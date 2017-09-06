const eg = require('../../eg');

module.exports = class extends eg.Generator {
  constructor (args, opts) {
    super(args, opts);

    this.configureCommand({
      command: 'configure <plugin> [options]',
      description: 'Configure a plugin',
      builder: yargs =>
        yargs
          .usage(`Usage: $0 ${process.argv[2]} configure <plugin> [options]`)
          .example(`$0 ${process.argv[2]} configure url-rewrite -p "allowRedirect=true"`)
    });
  }
};
