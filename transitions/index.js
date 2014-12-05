var follow = require('follow'),
    _ = require('underscore'),
    async = require('async'),
    path = require('path'),
    fs = require('fs'),
    date = require('../date'),
    utils = require('../lib/utils'),
    logger = require('../lib/logger'),
    config = require('../config'),
    transitions = {};

if (!process.env.TEST_ENV) {
    _.each(config.get('transitions'), function(conf, key) {
        if (conf.disable) {
            return;
        }
        try {
            transitions[key] = require('../' + conf.load);
        } catch(e) {
            // only log exceptions
            logger.error(e);
        }
    });
}

module.exports = {
    /*
     * Determines whether a transition is okay to run on a document.
     * Removed repeatable logic, assuming all transitions are repeatable
     * without adverse effects.
     */
    canRun: function(options) {
        var key = options.key,
            change = options.change,
            doc = change.doc,
            transition = options.transition;

        var _isRevSame = function() {
            if (doc.transitions && doc.transitions[key]) {
                return parseInt(doc._rev) === doc.transitions[key].last_rev;
            }
        };

        /*
         * Ignore deleted records, confirm transition has filter function and
         * skip transition if filter returns false.
         *
         * If transition was already applied then only run again if doc rev is
         * not equal to transtion rev.
         */
        return Boolean(
            doc &&
            options &&
            options.change &&
            !options.change.deleted &&
            transition &&
            typeof transition.filter === 'function' &&
            transition.filter(doc) &&
            !_isRevSame()
        );
    },
    attach: function(design) {
        var db = require('../db'),
            audit = require('couchdb-audit').withNode(db, db.user);

        /*
         * All transitions reference the same change.doc and work in series to
         * apply changes to it.
         */
        var applyTransition = function(options, callback) {

            var key = options.key,
                change = options.change,
                transition = options.transition;

            logger.debug(
                'calling transition.onMatch for doc %s seq %s and transition %s',
                change.id, change.seq, key
            );

            /*
             * Transitions are async and should return true if the document was
             * modified.
             */
            transition.onMatch(change, db, audit, function(err, changed) {
                logger.debug(
                    'finished transition for doc %s seq %s transition %s',
                    change.id, change.seq, key
                );
                if (err || !changed) {
                    return callback(err);
                }
                var doc = change.doc;
                //console.log('doc', JSON.stringify(doc,null,2));
                _.defaults(doc, {
                    transitions: {}
                });
                // mark transitions as finished including error state
                doc.transitions[key] = {
                    ok: !err,
                    last_rev: parseInt(doc._rev) + 1, // because it's the revision AFTER a save
                    seq: change.seq
                };
                callback(null, changed);
            });
        }

        var feed = new follow.Feed({
            db: process.env.COUCH_URL,
            include_docs: true,
            since: 0
        });

        var match_types = [
            'data_record',
            'clinic',
            'health_center',
            'district'
        ];

        feed.filter = function(doc, req) {
            /*
             * req.query is the parameters from the _changes request and
             * also feed.query_params.
             */
            if (match_types.indexOf(doc.type) >= 0) {
                return true;
            }
            return false;
        };

        /*
         * Putting all saves in a queue, not sure why but feels safer right
         * now. Letting the saves race (run in parallel) might provide a little
         * more performance, need to test a bit more.
        var saveQueue = async.queue(function(options, callback) {
            audit.saveDoc(options.change.doc, callback);
        }, 1);
         */

        feed.on('change', function(change) {

            logger.info(
                'change event on doc %s seq %s',
                change.id, change.seq
            );

            var operations = [];
            _.each(transitions, function(transition, key) {
                var opts = {
                    key: key,
                    change: change,
                    transition: transition
                };
                if (!module.exports.canRun(opts)) {
                    logger.debug('skipping transition %s %s', key, change.seq);
                    return;
                }
                operations.push(function(cb) {
                    applyTransition(opts, function(err, changed) {
                        /*
                         * Transition error short circuits async.series,
                         * effectively throwing away the changes.  Transition
                         * will be retried on next change event on doc.
                         */
                        if (err) {
                            logger.error(
                                'transition %s returned error doc %s seq %s: %s',
                                key, change.id, change.seq, JSON.stringify(err)
                            );
                        }
                        cb(err, changed);
                    });
                });
            });

            /*
             * Run transitions in a series and save the doc if we have changes.
             * Otherwise transitions did nothing and saving is unnecessary.  If
             * results has a true value in it then a change was made. If
             * transition gives an error then we abort processing this change.
             */
            async.series(operations, function(err, results) {
                logger.debug(
                    'transition results: %s', JSON.stringify(results)
                );
                if (err) {
                    return logger.error(
                        'transition error, skipping save for doc %s seq %s: %s',
                        change.id, change.seq, JSON.stringify(err)
                    );
                }
                var changed = _.some(results, function(i) {
                    return Boolean(i);
                });
                if (changed) {
                    logger.info(
                        'saving changes on doc %s seq %s',
                        change.id, change.seq
                    );
                    audit.saveDoc(change.doc, function(err) {
                        // todo: how to handle a failed save? for now just
                        // waiting until next change.
                        if (err) {
                            logger.error(
                                'Error saving changes on doc %s seq %s: %s',
                                change.id, change.seq, JSON.stringify(err)
                            );
                        }
                    });
                } else {
                    logger.debug(
                        'nothing changed skipping audit.save for doc %s seq %s',
                        change.id, change.seq
                    );
                }
            });
        });

        feed.follow();

    }
}
