var couchdb = require('felix-couchdb'),
	url = require('url'),
    settings;

if (process.env.COUCH_URL) {
	var couch_url = url.parse(process.env.COUCH_URL);

	settings = {
		port: couch_url.port,
		host: couch_url.hostname,
		db : couch_url.path
	};
	if (couch_url.auth) {
		var index = couch_url.auth.indexOf(':');
		settings.username = couch_url.substring(0, index);
		settings.password = couch_url.substring(index + 1);
	}
} else {
    console.log(
        "Please define a COUCH_URL in your environment e.g. \n" +
        "export COUCH_URL='http://admin:123qwe@localhost:5984/kujua-lite'"
    );
    process.exit(1);
}

var client = couchdb.createClient(
    settings.port,
    settings.host,
    settings.username,
    settings.password
);
module.exports = client.db(settings.db);
