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

    const previousPluginOptions =
      systemConfig.plugins && systemConfig.plugins[name] ?
        systemConfig.plugins[name] : {};

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
    // NOTE (kevinswiber): Updating YAML while maintaining presentation
    // style is not easy.  We're using the YAWN library here, which has
    // a decent approach given the current state of available YAML parsers,
    // but it's far from perfect.  Take a look at existing YAWN issues
    // before making any optimizations.  If any section of this code looks
    // ugly or inefficient, it may be that way for a reason.
    //
    // ¯\_(ツ)_/¯
    //
    // https://github.com/mohsen1/yawn-yaml/issues
 
    const name = this.pluginManifest.name || this.pluginName;
    const policyNames = this.pluginManifest.policies || [];

    const config = require('../../../lib/config');

    if (this.enablePlugin) {
      const isJSON = config.systemConfigPath.toLowerCase().endsWith('.json');
      const isYAML = !isJSON;

      const systemConfig = fs.readFileSync(config.systemConfigPath);

      // YAML-specific variables
      let yawn = null;
      let oldLength = null;

      let obj = null;

      if (isYAML) {
        yawn = new YAWN(systemConfig.toString());
        obj = Object.assign({}, yawn.json);

        oldLength = obj.plugins ? null : yawn.yaml.length;
      } else {
        obj = JSON.parse(systemConfig.toString());
      }

      let plugins = obj.plugins || {};

      if (!plugins.hasOwnProperty(name)) {
        plugins[name] = null;
      }

      if (name !== this.pluginName) {
        plugins[name] = plugins[name] || {};
        plugins[name].package = this.pluginName;
        obj.plugins = plugins;

        if (isYAML) {
          obj = this._updateYAML(obj, yawn);
        }
      }

      if (this.pluginOptions) {
        plugins[name] = plugins[name] || {};
        const self = this;
        const keys = Object.keys(self.pluginOptions);

        // YAWN needs to be updated by smallest atomic unit
        keys.forEach(key => {
          plugins[name][key] = self.pluginOptions[key];
          obj.plugins = plugins;

          if (isYAML) {
            obj = this._updateYAML(obj, yawn);
            plugins = obj.plugins;
          }
        });
      }

      if (isYAML && oldLength) {
        // add a line break before new plugins mapping
        yawn.yaml = yawn.yaml.substr(0, oldLength) + os.EOL +
          yawn.yaml.substr(oldLength);
      }

      const output = isYAML ? yawn.yaml.trim() : JSON.stringify(obj, null, 2);

      fs.writeFileSync(config.systemConfigPath, output);
    }

    if (this.addPoliciesToWhitelist) {
      const isJSON = config.gatewayConfigPath.toLowerCase().endsWith('.json');
      const isYAML = !isJSON;

      const gatewayConfig = fs.readFileSync(config.gatewayConfigPath);

      // YAML-specific variable
      let yawn = null;

      let obj = null;

      if (isYAML) {
        yawn = new YAWN(gatewayConfig.toString());
        obj = Object.assign({}, yawn.json);
      } else {
        obj = JSON.parse(gatewayConfig.toString());
      }

      let policies = obj.policies || [];

      // YAWN reverses arrays
      const correctedPolicyNames = isYAML ? policyNames.reverse() : policyNames;
      
      correctedPolicyNames.forEach(policy => {
        if (policies.indexOf(policy) === -1) {
          policies.push(policy);
        }
      });

      obj.policies = policies;

      if (isYAML) {
        yawn.json = obj;
      }

      const output = isYAML ? yawn.yaml.trim() : JSON.stringify(obj, null, 2);

      fs.writeFileSync(config.gatewayConfigPath, output);
    }
  }

  _updateYAML(obj, yawn) {
    yawn.json = obj;
    return yawn.json;
  }

  end () {
    this.stdout('Plugin installed!');
  }
};
