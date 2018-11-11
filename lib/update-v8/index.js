'use strict';

const Listr = require('listr');

const { getListrOptions } = require('./common');
const backport = require('./backport');
const updateVersionNumbers = require('./updateVersionNumbers');
const commitUpdate = require('./commitUpdate');
const majorUpdate = require('./majorUpdate');
const minorUpdate = require('./minorUpdate');
const updateV8Clone = require('./updateV8Clone');

exports.major = function(options) {
  const tasks = new Listr(
    [updateV8Clone(), majorUpdate(), commitUpdate(), updateVersionNumbers()],
    getListrOptions(options)
  );
  return tasks.run(options);
};

exports.minor = function(options) {
  const tasks = new Listr(
    [updateV8Clone(), minorUpdate(), commitUpdate()],
    getListrOptions(options)
  );
  return tasks.run(options);
};

exports.backport = backport.main;
