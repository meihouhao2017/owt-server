/*global require, setInterval, clearInterval, GLOBAL, process*/
'use strict';
var Getopt = require('node-getopt');
var spawn = require('child_process').spawn;
var fs = require('fs');
var toml = require('toml');
var log = require('./logger').logger.getLogger('ErizoAgent');

var config;
try {
  config = toml.parse(fs.readFileSync('./agent.toml'));
} catch (e) {
  log.error('Parsing config error on line ' + e.line + ', column ' + e.column + ': ' + e.message);
  process.exit(1);
}

// Configuration default values
GLOBAL.config = config || {};
GLOBAL.config.agent = GLOBAL.config.agent || {};
GLOBAL.config.agent.maxProcesses = GLOBAL.config.agent.maxProcesses || 1;
GLOBAL.config.agent.prerunProcesses = GLOBAL.config.agent.prerunProcesses || 1;
GLOBAL.config.agent.publicIP = GLOBAL.config.agent.publicIP || '';
GLOBAL.config.agent.internalIP = GLOBAL.config.agent.internalIP || '';

GLOBAL.config.recording = GLOBAL.config.recording || {};
GLOBAL.config.recording.path = GLOBAL.config.recording.path || '/tmp';

// Parse command line arguments
var getopt = new Getopt([
  ['r' , 'rabbit-host=ARG'            , 'RabbitMQ Host'],
  ['g' , 'rabbit-port=ARG'            , 'RabbitMQ Port'],
  ['l' , 'logging-config-file=ARG'    , 'Logging Config File'],
  ['M' , 'maxProcesses=ARG'           , 'Stun Server URL'],
  ['P' , 'prerunProcesses=ARG'        , 'Default video Bandwidth'],
  ['U' , 'my-purpose=ARG'             , 'Purpose of this agent'],
  ['h' , 'help'                       , 'display this help']
]);

var myId = '';
var myPurpose = 'webrtc';
var myState = 2;
var reuse = true;

var opt = getopt.parse(process.argv.slice(2));

for (var prop in opt.options) {
    if (opt.options.hasOwnProperty(prop)) {
        var value = opt.options[prop];
        switch (prop) {
            case 'help':
                getopt.showHelp();
                process.exit(0);
                break;
            case 'rabbit-host':
                GLOBAL.config.rabbit = GLOBAL.config.rabbit || {};
                GLOBAL.config.rabbit.host = value;
                break;
            case 'rabbit-port':
                GLOBAL.config.rabbit = GLOBAL.config.rabbit || {};
                GLOBAL.config.rabbit.port = value;
                break;
            case 'my-purpose':
                if (value === 'webrtc' ||
                    value === 'rtsp' ||
                    value === 'file' ||
                    value === 'audio' ||
                    value === 'video') {
                    myPurpose = value;
                } else {
                    process.exit(0);
                }
                break;
            default:
                GLOBAL.config.agent[prop] = value;
                break;
        }
    }
}

var clusterWorker = require('./clusterWorker');
var rpc = require('./amqper');

const INTERVAL_TIME_REPORT = GLOBAL.config.agent.interval_time_report;
var EXTERNAL_INTERFACE_NAME = GLOBAL.config.agent.externalNetworkInterface;
var INTERNAL_INTERFACE_NAME = GLOBAL.config.agent.internalNetworkInterface;

GLOBAL.config.erizo.hardwareAccelerated = !!GLOBAL.config.erizo.hardwareAccelerated;

var idle_erizos = [];
var erizos = [];
var processes = {};
var tasks = {}; // {erizo_id: [RoomID]}
var worker;
var load_collection = {period: INTERVAL_TIME_REPORT || 1000};

var guid = (function() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
               .toString(16)
               .substring(1);
  }
  return function() {
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
           s4() + '-' + s4() + s4() + s4();
  };
})();

var launchErizoJS = function() {
    log.info('Running process');
    var id = guid();
    var out = fs.openSync('../logs/erizo-' + id + '.log', 'a');
    var err = fs.openSync('../logs/erizo-' + id + '.log', 'a');
    var erizoProcess = spawn('node', ['./erizoJS.js', id, myPurpose, privateIP, publicIP], { detached: true, stdio: [ 'ignore', out, err ] });
    erizoProcess.unref();
    erizoProcess.on('close', function (code) {
        var index = idle_erizos.indexOf(id);
        var index2 = erizos.indexOf(id);
        if (index > -1) {
            idle_erizos.splice(index, 1);
            launchErizoJS();
        } else if (index2 > -1) {
            erizos.splice(index2, 1);
        }
        delete processes[id];
        delete tasks[id];
        log.info(id, 'exit with', code);
        fillErizos();
    });
    processes[id] = erizoProcess;
    tasks[id] = [];
    idle_erizos.push(id);
};

var dropErizoJS = function(erizo_id, callback) {
   if (processes.hasOwnProperty(erizo_id)) {
      var process = processes[erizo_id];
      process.kill();
      delete processes[erizo_id];
      delete tasks[erizo_id];

      var index = erizos.indexOf(erizo_id);
      if (index !== -1) {
          erizos.splice(index, 1);
      }

      var idleIndex = idle_erizos.indexOf(erizo_id);
      if (idleIndex !== -1) {
          idle_erizos.splice(idleIndex, 1);
      }

      callback('callback', 'ok');
   }
};

var fillErizos = function() {
    for (var i = idle_erizos.length; i < GLOBAL.config.agent.prerunProcesses; i++) {
        launchErizoJS();
    }
};

var api = {

    getErizoJS: function(room_id, callback) {
        try {
            var i, erizo_id;
            for (i in erizos) {
                erizo_id = erizos[i];
                if (reuse && tasks[erizo_id] !== undefined && tasks[erizo_id].indexOf(room_id) !== -1) {
                    callback('callback', erizo_id);
                    worker && worker.addTask(room_id);
                    return;
                }
            }

            for (i in idle_erizos) {
                erizo_id = idle_erizos[i];
                if (reuse && tasks[erizo_id] !== undefined && tasks[erizo_id].indexOf(room_id) !== -1) {
                    callback('callback', erizo_id);
                    worker && worker.addTask(room_id);
                    return;
                }
            }

            erizo_id = idle_erizos.shift();
            worker && worker.addTask(room_id);
            callback('callback', erizo_id);

            tasks[erizo_id].push(room_id);
            erizos.push(erizo_id);

            if (reuse && ((erizos.length + idle_erizos.length + 1) >= GLOBAL.config.agent.maxProcesses)) {
                // We re-use Erizos
                var reused_erizo = erizos.shift();
                idle_erizos.push(reused_erizo);
            } else {
                // We launch more processes
                fillErizos();
            }
        } catch (error) {
            log.error('Error in ErizoAgent:', error);
        }
    },

    recycleErizoJS: function(id, room_id, callback) {
        try {
            if (tasks[id]) {
                var i = tasks[id].indexOf(room_id);
                if (i !== -1) {
                    tasks[id].splice(i, 1);
                }

                if (tasks[id].length === 0) {
                    dropErizoJS(id, callback);
                }
            }

            var stillInUse = false;
            for (var eid in tasks) {
                if (tasks[eid].indexOf(room_id) !== -1) {
                    stillInUse = true;
                    break;
                }
            }
            !stillInUse && worker && worker.removeTask(room_id);
        } catch(err) {
            log.error('Error stopping ErizoJS');
        }
    }
};

var privateIP, publicIP, clusterIP;
var externalInterface, internalInterface;
function collectIPs () {
    var interfaces = require('os').networkInterfaces(),
        externalAddress,
        internalAddress,
        k,
        k2,
        address;

    for (k in interfaces) {
        if (interfaces.hasOwnProperty(k)) {
            for (k2 in interfaces[k]) {
                if (interfaces[k].hasOwnProperty(k2)) {
                    address = interfaces[k][k2];
                    if (address.family === 'IPv4' && !address.internal) {
                        if (!externalInterface && (k === EXTERNAL_INTERFACE_NAME || !EXTERNAL_INTERFACE_NAME)) {
                            externalInterface = k;
                            externalAddress = address.address;
                        }
                        if (!internalInterface && (k === INTERNAL_INTERFACE_NAME || !INTERNAL_INTERFACE_NAME)) {
                            internalInterface = k;
                            internalAddress = address.address;
                        }
                    }
                }
            }
        }
    }

    privateIP = externalAddress;

    if (GLOBAL.config.agent.publicIP === '' || GLOBAL.config.agent.publicIP === undefined){
        publicIP = externalAddress;
    } else {
        publicIP = GLOBAL.config.agent.publicIP;
    }

    if (GLOBAL.config.agent.internalIP === '' || GLOBAL.config.agent.internalIP === undefined) {
        clusterIP = internalAddress;
    } else {
        clusterIP = GLOBAL.config.agent.internalIP;
    }
}

var reportInterval;
var joinCluster = function (on_ok) {
    var joinOK = function (id) {
        myId = id;
        myState = 2;
        log.info(myPurpose, 'agent join cluster ok.');
        on_ok(id);
    };

    var joinFailed = function (reason) {
        log.error(myPurpose, 'agent join cluster failed. reason:', reason);
        worker && worker.quit();
    };

    var loss = function () {
        log.info(myPurpose, 'agent lost.');
    };

    var recovery = function () {
        log.info(myPurpose, 'agent recovered.');
    };

    var spec = {amqper: rpc,
                purpose: myPurpose,
                clusterName: GLOBAL.config.agent.cluster_name || 'woogeenCluster',
                joinRery: GLOBAL.config.agent.join_cluster_retry || 5,
                joinPeriod: GLOBAL.config.agent.join_cluster_period || 3000,
                recoveryPeriod: GLOBAL.config.agent.recover_cluster_period || 1000,
                keepAlivePeriod: GLOBAL.config.agent.interval_time_keepAlive || 1000,
                info: {ip: clusterIP,
                       purpose: myPurpose,
                       state: 2,
                       max_load: GLOBAL.config.agent.max_load || 0.85
                      },
                onJoinOK: joinOK,
                onJoinFailed: joinFailed,
                onLoss: loss,
                onRecovery: recovery,
                loadCollection: load_collection
               };

    worker = clusterWorker(spec);
};

(function init_env() {
    reuse = (myPurpose === 'audio' || myPurpose === 'video') ? false : true;

    collectIPs();

    switch (myPurpose) {
        case 'webrtc':
        case 'rtsp':
            var concernedInterface = externalInterface || internalInterface;
            if (!concernedInterface) {
                for (var i in os.networkInterfaces()) {
                    for (j in os.networkInterfaces()[i]) {
                        if (!os.networkInterfaces()[i][j].internal) {
                            concernedInterface = i;
                            break;
                        }
                    }
                    if (concernedInterface) {
                        break;
                    }
                }
            }

            load_collection.item = {name: 'network',
                                    interf: concernedInterface || 'lo',
                                    max_scale: GLOBAL.config.agent.network_max_scale || 1000};
            break;
        case 'file':
            load_collection.item = {name: 'disk',
                                    drive: GLOBAL.config.recording.path};
            break;
        case 'audio':
            load_collection.item = {name: 'cpu'};
            break;
        case 'video':
            /*FIXME: should be double checked whether hardware acceleration is actually running*/
            load_collection.item = {name: (GLOBAL.config.erizo.hardwareAccelerated ? 'gpu' : 'cpu')};
            break;
        default:
            load_collection.item = {name: 'cpu'};
            break;
    }
})();

var onTermination = function () {
    worker && worker.quit();
    Object.keys(processes).map(function (k) {
        dropErizoJS(k, function (unused, status) {
            log.info('Terminate ErizoJS', k, status);
        });
    });
};

rpc.connect(GLOBAL.config.rabbit, function () {
    rpc.setPublicRPC(api);
    log.info('Adding agent to cloudhandler, purpose:', myPurpose);

    joinCluster(function (rpcID) {
      rpc.bind(rpcID, function () {
        log.info('ErizoAgent rpcID:', rpcID);
      });
      fillErizos();
    });
});

['SIGINT', 'SIGTERM'].map(function (sig) {
    process.on(sig, function () {
        log.warn('Exiting on', sig);
        process.exit();
    });
});

process.on('exit', function () {
    onTermination();
});
