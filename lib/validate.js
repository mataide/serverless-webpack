'use strict';

const BbPromise = require('bluebird');
const path = require('path');
const fse = require('fs-extra');
const globby = require('globby');
const lib = require('./index');
const _ = require('lodash');

/**
 * For automatic entry detection we sort the found files to solve ambiguities.
 * This should cover most of the cases. For complex setups the user should
 * build his own entries with help of the other exports.
 */
const preferredExtensions = [
  '.js',
  '.ts',
  '.jsx',
  '.tsx'
];

module.exports = {
  validate() {
    const getHandlerFile = handler => {
      // Check if handler is a well-formed path based handler.
      const handlerEntry = /(.*)\..*?$/.exec(handler);
      if (handlerEntry) {
        return handlerEntry[1];
      }
    };

    const getEntryExtension = fileName => {
      const files = globby.sync(`${fileName}.*`, {
        cwd: this.serverless.config.servicePath || process.cwd(),
        nodir: true
      });

      if (_.isEmpty(files)) {
        // If we cannot find any handler we should terminate with an error
        throw new this.serverless.classes.Error(`No matching handler found for '${fileName}'. Check your service definition.`);
      }

      // Move preferred file extensions to the beginning
      const sortedFiles = _.uniq(
        _.concat(
          _.sortBy(
            _.filter(files, file => _.includes(preferredExtensions, path.extname(file))),
            a => _.size(a)
          ),
          files
        )
      );

      if (_.size(sortedFiles) > 1) {
        this.serverless.cli.log(`WARNING: More than one matching handlers found for '${fileName}'. Using '${_.first(sortedFiles)}'.`);
      }
      return path.extname(_.first(sortedFiles));
    };

    const getEntryForFunction = (name, serverlessFunction) => {
      const handler = serverlessFunction.handler;

      const handlerFile = getHandlerFile(handler);
      if (!handlerFile) {
        _.get(this.serverless, 'service.provider.name') !== 'google' &&
          this.serverless.cli.log(`\nWARNING: Entry for ${name}@${handler} could not be retrieved.\nPlease check your service config if you want to use lib.entries.`);
        return {};
      }
      const ext = getEntryExtension(handlerFile);

      // Create a valid entry key
      return {
        [handlerFile]: `./${handlerFile}${ext}`
      };
    };

    this.webpackConfig = (
      this.serverless.service.custom &&
      this.serverless.service.custom.webpack ||
      'webpack.config.js'
    );

    // Expose entries - must be done before requiring the webpack configuration
    const entries = {};

    const functions = this.serverless.service.getAllFunctions();
    if (this.options.function) {
      const serverlessFunction = this.serverless.service.getFunction(this.options.function);
      const entry = getEntryForFunction.call(this, this.options.function, serverlessFunction);
      _.merge(entries, entry);
    } else {
      _.forEach(functions, (func, index) => {
        const entry = getEntryForFunction.call(this, functions[index], this.serverless.service.getFunction(func));
        _.merge(entries, entry);
      });
    }

    // Expose service file and options
    lib.serverless = this.serverless;
    lib.options = this.options;
    lib.entries = entries;

    if (_.isString(this.webpackConfig)) {
      const webpackConfigFilePath = path.join(this.serverless.config.servicePath, this.webpackConfig);
      if (!this.serverless.utils.fileExistsSync(webpackConfigFilePath)) {
        throw new this.serverless.classes
          .Error('The webpack plugin could not find the configuration file at: ' + webpackConfigFilePath);
      }
      try {
        this.webpackConfig = require(webpackConfigFilePath);
      } catch (err) {
        this.serverless.cli.log(`Could not load webpack config '${webpackConfigFilePath}'`);
        return BbPromise.reject(err);
      }
    }

    // Default context
    if (!this.webpackConfig.context) {
      this.webpackConfig.context = this.serverless.config.servicePath;
    }

    // Default target
    if (!this.webpackConfig.target) {
      this.webpackConfig.target = 'node';
    }

    // Default output
    if (!this.webpackConfig.output || _.isEmpty(this.webpackConfig.output)) {
      const outputPath = path.join(this.serverless.config.servicePath, '.webpack');
      this.webpackConfig.output = {
        libraryTarget: 'commonjs',
        path: outputPath,
        filename: '[name].js',
      };
    }

    // Custom output path
    if (this.options.out) {
      this.webpackConfig.output.path = path.join(this.serverless.config.servicePath, this.options.out);
    }

    if (!this.keepOutputDirectory) {
      this.options.verbose && this.serverless.cli.log(`Removing ${this.webpackConfig.output.path}`);
      fse.removeSync(this.webpackConfig.output.path);
    }
    this.webpackOutputPath = this.webpackConfig.output.path;

    // In case of individual packaging we have to create a separate config for each function
    if (_.has(this.serverless, 'service.package') && this.serverless.service.package.individually) {
      this.options.verbose && this.serverless.cli.log('Using multi-compile (individual packaging)');
      this.multiCompile = true;

      if (this.webpackConfig.entry && !_.isEqual(this.webpackConfig.entry, entries)) {
        return BbPromise.reject(new this.serverless.classes
          .Error('Webpack entry must be automatically resolved when package.individually is set to true. ' +
            'In webpack.config.js, remove the entry declaration or set entry to slsw.lib.entries.'));
      }

      // Lookup associated Serverless functions
      const allEntryFunctions = _.map(
        this.serverless.service.getAllFunctions(),
        funcName => {
          const func = this.serverless.service.getFunction(funcName);
          const handler = func.handler;
          const handlerFile = path.relative('.', getHandlerFile(handler));
          return {
            handlerFile,
            funcName,
            func
          };
        }
      );

      this.entryFunctions = _.flatMap(entries, (value, key) => {
        const entry = path.relative('.', value);
        const entryFile = _.replace(entry, new RegExp(`${path.extname(entry)}$`), '');

        const entryFuncs = _.filter(allEntryFunctions, [ 'handlerFile', entryFile ]);
        if (_.isEmpty(entryFuncs)) {
          // We have to make sure that for each entry there is an entry function item.
          entryFuncs.push({});
        }
        _.forEach(entryFuncs, entryFunc => {
          entryFunc.entry = {
            key,
            value
          };
        });
        return entryFuncs;
      });

      this.webpackConfig = _.map(this.entryFunctions, entryFunc => {
        const config = _.cloneDeep(this.webpackConfig);
        config.entry = {
          [entryFunc.entry.key]: entryFunc.entry.value
        };
        const compileName = entryFunc.funcName || _.camelCase(entryFunc.entry.key);
        config.output.path = path.join(config.output.path, compileName);
        return config;
      });
    } else {
      this.webpackConfig.output.path = path.join(this.webpackConfig.output.path, 'service');
    }

    return BbPromise.resolve();
  },
};
