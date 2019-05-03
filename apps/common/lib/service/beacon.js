var promise       = require ('bluebird');
var moment        = require ('moment');
var store         = require ('../../../../common/store');
var Error_3A      = require ('../../../../common/3a-error');
var natsiface     = require ('../../../../common/nats-iface');
var log           = require ('../../../../common/log').child ({ module : 'apps/common/lib/service/beacon'});

var beacon  = {};
/*
 * This should be configurable */
var map     = {};
var cache   = {};
var beacon_interval = 15 * 1000;

var subject = {
	discovery : 'service.discovery',
	pull      : 'service.pull'
};

beacon.init = function () {
	var _d = promise.pending ();

	natsiface.open_channel (subject.discovery, parse_msg);
	beacon.ask ();

	_d.resolve();
	return _d.promise;
};

beacon.ask = function () {
	var msg = new app_msg ();
	natsiface.send (subject.pull, msg);
	/*
	 * TODO
	 * bad log, message not printing
	 * reason seems to be it being instance of a function */
	log.info ({msg : msg, channel : subject.pull}, 'sending msg on nats');
};

function parse_msg (err, channel, __msg, replyTo) {

	if (err) 
		return log.error ({err : err, channel : channel, msg : __msg}, 'error parsing message');

	let msg = __msg;

	switch (msg.header['msg-name']) {
		case 'service-announcement' :
			beacon.info (msg);
			break;

		default :
			log.error ({msg : msg}, 'unrecognised msg name. ignored');
			break;
	}
}

/*
 * parse instance info and adjust service map accordingly*/
beacon.info = function (srv_msg) {
	let header  = srv_msg.header;
	let payload = srv_msg.payload;

	switch (payload.state) {
		case 'active' : 
			payload.last_active = header.timestamp;
			beacon_active (payload);
			break;

		case 'down' : 
			beacon_down (payload, 'service shutting down');
			break;
	}
};

/*
 * Get all the usable instances of a service */
beacon.get_instances_cached = function (s_name) {
	/*
	 * This returns cached maps optimsied for load-balancer needs (array form)
	 * NEVER READ FOLLOWING INFO FROM CACHE
	 *  - last_active (will be old)
	 *  - state (will be incorrect, will always be set to active)*/
	if (!cache[s_name])
		cache[s_name] = [];

	return cache[s_name];
};

/*
 * Recived info about an instance from upstream module */
beacon.instance_info = function (instance, err) {
	if (err)
		return service_error (instance, err);

	service_ok (instance);
};

/* Add beacon to map and rebuild cache if needed */
function beacon_active (__payload) {
	__payload.failure_count = 0;
	if (!map[__payload.name])
		map[__payload.name] = {};

	if (!map[__payload.name][__payload.id])  {
		log.info ({srv_instance : __payload}, 'new instance discovered');
		map[__payload.name][__payload.id] = __payload;
		return rebuild_cache (__payload.name);
	}

	/*
	 * Not new info, just modify the map */
	map[__payload.name][__payload.id] = __payload;
}

/*
 * Delete beacon, rebuild cache */
function beacon_down (__payload, reason) {
	if (!map[__payload.name] || !map[__payload.name][__payload.id])
		return log.warn ({__payload : __payload}, 'no such service(to delete) in service map, moving on');

	log.info ({service : __payload, reason : reason}, 'service down. deleting map entry');
	delete map[__payload.name][__payload.id];
	return rebuild_cache (__payload.name);
}

/*
 * rebuild service_cache array for given service */
function rebuild_cache (__s_name) {
	/*
	 * TODO
	 * Right now rebuilding whole cache
	 * could later be optimisd to only add or delete required entries, instead of full rebuild */
	cache[__s_name] = [];

	for (let __srv_id in map[__s_name]) 
		cache[__s_name].push (map[__s_name][__srv_id]);
}

/*
 * Parse the error and decide wether the service is down or maybe-active */
function service_error (_instance, _err) {

	switch (_err.name) {
		case 'ECONNREFUSED' : 
			change_state (_instance, 'down');
			break;

		case 'ETIMEDOUT' : 
			change_state (_instance, 'maybe-active');
			break;

		default : 
			log.debug ({err : _err, service : _instance.name }, 'service request error. service is likely still alive. ignoring');
			change_state (_instance, 'active');
			break;
	}
}

/*
 * Mark the service as active*/
function service_ok (_instance) {
	change_state (_instance, 'active');
}


/*
 * Change and save te state of the given service instance */
function change_state (instance, _state) {

	/*
	 * Using actual map instance from here on out for any modifications */
	let _instance = map[instance.name][instance.id];

	switch (_state) {
		case 'down' : 
			_instance.state = 'down';
			beacon_down (_instance, 'error reaching service');
			break;

		case 'maybe-active' : 
			_instance.failure_count++;
			_instance.state = 'maybe-active';
			map[_instance.name][_instance.id] = _instance;
			if (_instance.failure_count > 3)
				beacon_down (_instance, 'too many request failures');
			break;

		case 'active' :
			_instance.failure_count = 0;
			_instance.state = 'active';
			map[_instance.name][_instance.id] = _instance;
			break;

		default : 
			log.error ({_instance : _instance, state : _state}, 'unkown state, not doing anything to instance, moving on');
			break;
	}
}

/*
 * delete stale entries based on 
 * - Number of missed pings
 * - Number of failed calls */
function prune (s_name) {
	/*
	 * See if any service needs to be downed */
	var delete_these = [];
	/*
	 * Find which keys to delete*/
	for (let s_id in map[s_name]) {
		/*
		 * If instance is 4times older than beacon interval delete the entry */
		let instance_time = new Date (map[s_name][s_id].last_active);
		let now           = new Date ();
		let diff          = Math.floor((now - instance_time) / 1000);
		let missed_pings  = Math.floor(diff / (beacon_interval / 1000));

		if (missed_pings > 3 || map[s_name][s_id].failure_count > 3) {
			/*
			 * delete this entry it's either :
			 * - too old -missed 4 pings 
			 * - or failed atleast 4 times */
			delete_these.push(s_id);
		}
	}


	/*
	 * Actual delete entries `*/
	for (let i = 0 ; i < delete_these.length; i++) 
		beacon_down (map[s_name][delete_these[i]], 'timely pruning (either too many failure or too many missed pings)');
}

/*
 * Services which are not used by a certain app wont get pruned
 * and will keep on stacking since prune won't get triggered (no api call to that service)
 * delete all stale entries from each service */
function map_cleaner () {
	for (let s_name in map)
		prune (s_name);
}

setInterval (map_cleaner, 4 * beacon_interval);

function app_msg () {
	this.header  = {
		'msg-name' :  'service-demand',
		'timestamp':  moment().toISOString(),
		'from'     : 'app/' + store.get('name'),
	};
	this.payload = {
		'name' : store.get ('name'),
		'proto': 'http',
	};
}

function __init__ () {
	beacon.init ();
}

__init__ ();


module.exports = beacon;
