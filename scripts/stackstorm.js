/*
 Licensed to the StackStorm, Inc ('StackStorm') under one or more
 contributor license agreements.  See the NOTICE file distributed with
 this work for additional information regarding copyright ownership.
 The ASF licenses this file to You under the Apache License, Version 2.0
 (the "License"); you may not use this file except in compliance with
 the License.  You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
limitations under the License.
*/

// Description:
//   StackStorm hubot integration
//
// Dependencies:
//
//
// Configuration:
//   ST2_API - FQDN + port to StackStorm endpoint
//   ST2_CHANNEL - StackStorm channel name used for notification
//   ST2_COMMANDS_RELOAD_INTERVAL - Reload interval for commands
//
// Notes:
//   Command list is automatically generated from StackStorm ChatOps metadata
//

"use strict";

var _ = require('lodash'),
  util = require('util'),
  env = process.env,
  utils = require('../lib/utils.js'),
  slack_monkey_patch = require('../lib/slack_monkey_patch.js'),
  formatCommand = require('../lib/format_command.js'),
  formatData = require('../lib/format_data.js'),
  CommandFactory = require('../lib/command_factory.js');

var st2client = require('st2client');

// Setup the Environment
env.ST2_API = env.ST2_API || 'http://localhost:9101';
env.ST2_CHANNEL = env.ST2_CHANNEL || 'hubot';
env.ST2_WEBUI_URL = env.ST2_WEBUI_URL || null;

// Optional authentication info
env.ST2_AUTH_USERNAME = env.ST2_AUTH_USERNAME || null;
env.ST2_AUTH_PASSWORD = env.ST2_AUTH_PASSWORD || null;

// Optional, if not provided, we infer it from the API URL
env.ST2_AUTH_URL = env.ST2_AUTH_URL || null;

// Command reload interval in seconds
env.ST2_COMMANDS_RELOAD_INTERVAL = env.ST2_COMMANDS_RELOAD_INTERVAL || 120;
env.ST2_COMMANDS_RELOAD_INTERVAL = parseInt(env.ST2_COMMANDS_RELOAD_INTERVAL, 10);

// Constants
// Fun human-friendly commands. Use %s for payload output.
var START_MESSAGES = [
    "I'll take it from here! Your execution ID for reference is %s",
    "Got it! Remember %s as your execution ID",
    "I'm on it! Your execution ID is %s",
    "Let me get right on that. Remember %s as your execution ID",
    "Always something with you. :) I'll take care of that. Your ID is %s",
    "I have it covered. Your execution ID is %s",
    "Let me start up the machine! Your execution ID is %s",
    "I'll throw that task in the oven and get cookin'! Your execution ID is %s",
    "Want me to take that off your hand? You got it! Don't forget your execution ID: %s"
];


module.exports = function(robot) {
  slack_monkey_patch.patchSendMessage(robot);

  var self = this;

  // Auth token we use to authenticate
  var auth_token = null;

  var client = robot.http(env.ST2_API);

  // factory to manage commands
  var command_factory = new CommandFactory(robot);

  var loadCommands = function() {
    var request;

    robot.logger.info('Loading commands....');

    // TODO: We should use st2client for this
    request = client.scope('/exp/actionalias');

    if (auth_token) {
      request = request.header('X-Auth-Token', auth_token);
    }

    request.get()(
      function(err, resp, body) {
        var parsed_body, success;

        parsed_body = JSON.parse(body);
        if (!_.isArray(parsed_body)) {
          success = false;
        } else {
          success = true;
        }

        if (!success) {
          robot.logger.error('Failed to retrieve commands: ' + body);
          return;
        }

        // Remove all the existing commands
        command_factory.removeCommands();

        _.each(parsed_body, function(action_alias) {
          var name, formats, description, i, format, command;

          if (!action_alias) {
            robot.logger.error('No action alias specified for command: ' + name);
            return;
          }

          name = action_alias.name;
          formats = action_alias.formats;
          description = action_alias.description;

          if (!formats || formats.length === 0) {
            robot.logger.error('No formats specified for command: ' + name);
            return;
          }

          for (i = 0; i < formats.length; i++) {
            format = formats[i];
            command = formatCommand(robot.logger, name, format, description);

            command_factory.addCommand(command, name, format, action_alias);
          }
        });
      }
    );
  };

  var executeCommand = function(msg, command_name, format_string, command) {
    var payload = {
      'name': command_name,
      'format': format_string,
      'command': command,
      'user': msg.message.user.name,
      'source_channel': msg.message.room,
      'notification_channel': env.ST2_CHANNEL
    };

    robot.logger.debug('Sending command payload %s ' + JSON.stringify(payload));

    client.scope('/exp/aliasexecution').post(JSON.stringify(payload)) (
      function(err, resp, body) {
        var message, history_url, execution_id;

        if (err) {
          msg.send(util.format('error : %s', err));
        } else if (resp.statusCode !== 200) {
          msg.send(util.format('status code "%s": %s', resp.statusCode, body));
        } else {
          execution_id = _.trim(body, '"');
          history_url = utils.getExecutionHistoryUrl(execution_id);

          message = START_MESSAGES[_.random(0, START_MESSAGES.length - 1)];
          message = util.format(message, execution_id);

          if (history_url) {
            message += util.format(' (details available at %s)', history_url);
          }

          msg.send(message);
        }
      }
    );
  };

  robot.respond(/(.+?)$/i, function(msg) {
    var command, result, command_name, format_string;

    command = msg.match[1].toLowerCase();
    result = command_factory.getMatchingCommand(command);

    if (!result) {
      // No command found
      return;
    }

    command_name = result[0];
    format_string = result[1];

    executeCommand(msg, command_name, format_string, command);
  });

  robot.router.post('/hubot/st2', function(req, res) {
    var data, message, channel, recipient, execution_id, history_url;

    try {
      if (req.body.payload) {
        data = JSON.parse(req.body.payload);
      } else {
        data = req.body;
      }
      message = formatData(data.message, '', robot.logger);

      // PM user, notify user, or tell channel
      if (data.user) {
        if (data.whisper === true) {
          recipient = data.user;
        } else {
          recipient = data.channel;
          message = util.format('%s :\n%s', data.user, message);
        }
      } else {
        recipient = data.channel;
      }

      execution_id = utils.getExecutionIdFromMessage(message);
      history_url = utils.getExecutionHistoryUrl(execution_id);

      if (history_url) {
        message += util.format('\n Execution details available at: %s', history_url);
      }

      robot.messageRoom(recipient, message);
      res.send('{"status": "completed", "msg": "Message posted successfully"}');
    } catch (e) {
      robot.logger.error("Unable to decode JSON: " + e);
      res.send('{"status": "failed", "msg": "An error occurred trying to post the message: ' + e + '"}');
    }
  });

  function start() {
    // Add an interval which tries to re-load the commands
    var commands_load_interval = setInterval(loadCommands.bind(self), (env.ST2_COMMANDS_RELOAD_INTERVAL * 1000));

    // Initial command loading
    loadCommands();
    return commands_load_interval;
  }

  // TODO: Use async.js or similar or organize this better
  if (!utils.isNull(env.ST2_AUTH_USERNAME) && !utils.isNull(env.ST2_AUTH_PASSWORD)) {
    var credentials, config, st2_client, parsed;

    credentials = {
      'user': env.ST2_AUTH_USERNAME,
      'password': env.ST2_AUTH_PASSWORD
    };
    config = {
      'rejectUnauthorized': false,
      'credentials': credentials
    };

    if (!utils.isNull(env.ST2_AUTH_URL)) {
      parsed = utils.parseUrl(env.ST2_AUTH_URL);

      config['auth'] = {};
      config['auth']['host'] = parsed['hostname'];
      config['auth']['protocol'] = parsed['protocol'];
      config['auth']['port'] = parsed['port'];
    }
    else {
      parsed = utils.parseUrl(env.ST2_API);

      config['host'] = parsed['hostname'];
      config['protocol'] = parsed['protocol'];
      config['port'] = parsed['port'];
    }

    st2_client = st2client(config);
    robot.logger.info('Performing authentication...');
    st2_client.authenticate(config.credentials.user, config.credentials.password).then(function(result) {
      robot.logger.debug('Successfully authenticated.');
      auth_token = result['token'];

      return start();
    }).catch(function(err) {
      robot.logger.error('Failed to authenticate: ' + err.message.toString());
      process.exit(2);
    });
  } else {
    return start();
  }
};
