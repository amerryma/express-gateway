const express = require('express');
const usersSrv = require('../../services').user;
const logger = require('../../logger').admin;

module.exports = function (app) {
  let router = express.Router();

  router.get('/', function (req, res, next) {
    next();
  });

  router.post('/', function (req, res, next) {
    next();
  });

  router.get('/:id', function (req, res, next) {
    next();
  });

  router.put('/:id', function (req, res, next) {
    next();
  });

  router.delete('/:id', function (req, res, next) {
    next();
  });

  return router;
};
