const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const YAWN = require('yawn-yaml/cjs');
const eg = require('../../eg');

module.exports = class extends eg.Generator {
  constructor (args, opts) {
    super(args, opts);

    this.pluginName = null;
    this.pluginManifest = null;
    this.pluginOptions = null;

    this.enablePlugin = false;
    this.addPoliciesToWhitelist = false;

    this.configureCommand({
      command: 'install <package> [options]',
      description: 'Install a plugin',
      builder: yargs =>
        yargs
          .usage(`Usage: $0 ${process.argv[2]} install <package> [options]`)
          .example(`$0 ${process.argv[2]} install express-gateway-plugin-url-rewrite`)
    });
  }

  initializing () {
    return new Promise(resolve => {
      // manually spawn npm
      // use --parseable flag to get tab-delimited output
      // forward sterr to process.stderr
      // capture stdout to get package name

      let pluginPath = null;

      const installArgs = [
        'install', this.argv.package,
        '--cache-min', 24 * 60 * 60,
        '--parseable'
      ];

      const installOpts = {
        cwd: this.env.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'inherit']
      };

      const npmInstall = spawn('npm', installArgs, installOpts);

      npmInstall.on('error', _ => {
        this.log.err('Cannot install', this.argv.package);
      });

      const bufs = [];
      let len = 0;
      npmInstall.stdout.on('readable', () => {
        const buf = npmInstall.stdout.read();

        if (buf) {
          bufs.push(buf);
          len += buf.length;
        }
      });

      npmInstall.stdout.on('end', () => {
        const lines = Buffer.concat(bufs, len)
          .toString()
          .trim()
          .split('\n');

        const output = lines[lines.length - 1].split('\t');

        if (output.length < 4) {
          this.log.error('Cannot parse npm output while installing plugin.');
          process.exit();
        }

        this.pluginName = output[1];
        pluginPath = path.join(this.env.cwd, output[3]);
      });

      npmInstall.on('exit', () => {
        if (pluginPath) {
          this.pluginManifest = require(pluginPath);
          resolve();
        }
      });
    });
  }

  prompting () {
    const optionsMeta = this.pluginManifest.options || {};
    const keys = Object.keys(optionsMeta);

    const config = require('../../../lib/config');
    const systemConfig = config.systemConfig;
    const name = this.pluginManifest.name || this.pluginName;

    const previousPluginOptions = systemConfig[name] || {};

    const pluginQuestions = keys.map(key => {
      const schema = optionsMeta[key];
      return {
        type: 'input',
        name: `pluginOption${key}`,
        message: `Set value for ${key} [${schema.title || key}]`,
        default: previousPluginOptions[key],
        validate: input => {
          const type = schema.type;

          if (['string', 'boolean', 'number'].indexOf(type) === -1) {
            this.log.error(
              `Invalid plugin option: ${key}. Type must be string, boolean, ` +
              'or number.');

            return false;
          }

          if (schema.required && !input) {
            return false;
          }

          if (type === 'number' && isNaN(input)) {
            return false;
          }

          if (type === 'boolean' && !(input === 'true' || input === 'false')) {
            return false;
          }

          return true;
        }
      };
    });

    return this.prompt(pluginQuestions.concat([
      {
        type: 'confirm',
        name: 'enablePlugin',
        message: 'Would you like to enable this plugin in system config?'
      },
      {
        type: 'confirm',
        name: 'addPoliciesToWhitelist',
        message: 'Would you like to add new policies to gateway config?'
      }
    ]))
    .then(answers => {
      this.enablePlugin = answers.enablePlugin;
      this.addPoliciesToWhitelist = answers.addPoliciesToWhitelist;

      if (pluginQuestions.length) {
        this.pluginOptions = {};

        const keys = pluginQuestions.map(opt => opt.name);
        const self = this;
        keys.forEach(key => {
          let answer = answers[key];
          const stripped = key.substr('pluginOption'.length);
          const optionMeta = optionsMeta[stripped];

          if (optionMeta && optionMeta.type && answer) {
            const type = optionMeta.type;
            if (type === 'number') {
              answer = Number(answer);
            } else if (type === 'boolean') {
              answer = Boolean(answer);
            }
          }

          self.pluginOptions[stripped] = answer;
        });
      }
    });
  }

  writing () {
    const name = this.pluginManifest.name || this.pluginName;
    const policyNames = this.pluginManifest.policies || [];

    const config = require('../../../lib/config');

    if (this.enablePlugin) {
      const systemConfig = fs.readFileSync(config.systemConfigPath);

      let yawn = new YAWN(systemConfig.toString());
      let obj = Object.assign({}, yawn.json);

      let oldLength = obj.plugins ? null : yawn.yaml.length;

      let plugins = obj.plugins || [];

      if (plugins.indexOf(name) === -1) {
        plugins.push(name);
      }

      obj.plugins = plugins;
      yawn.json = obj;

      if (oldLength) {
        // add a line break before new plugins array
        yawn.yaml = yawn.yaml.substr(0, oldLength) + os.EOL +
          yawn.yaml.substr(oldLength);

        obj = yawn.json;
      }

      oldLength = obj[name] ? null : yawn.yaml.length;

      obj = Object.assign({}, yawn.json);
      if (name !== this.pluginName) {
        obj[name] = { package: this.pluginName };
      }

      if (this.pluginOptions) {
        obj[name] = Object.assign(obj[name] || {}, this.pluginOptions);
      }

      yawn.json = obj;

      if (oldLength) {
        // add a line break before new plugin options object
        yawn.yaml = yawn.yaml.substr(0, oldLength) + os.EOL +
          yawn.yaml.substr(oldLength);
      }

      fs.writeFileSync(config.systemConfigPath, yawn.yaml.trim());
    }

    if (this.addPoliciesToWhitelist) {
      const gatewayConfig = fs.readFileSync(config.gatewayConfigPath);

      let yawn = new YAWN(gatewayConfig.toString());
      let obj = Object.assign({}, yawn.json);

      let policies = obj.policies || [];

      policyNames.reverse().forEach(policy => {
        if (policies.indexOf(policy) === -1) {
          policies.push(policy);
        }
      });

      obj.policies = policies;

      yawn.json = obj;
      fs.writeFileSync(config.gatewayConfigPath, yawn.yaml.trim());
    }
  }

  end () {
    this.stdout('Plugin installed!');
  }
};
