'use strict';

var utils = require('./utils');
var githubInfo = require('./github-info');
var template = require('./template');
var Github = require('github-api');
var fs = require('fs');
var chalk = require('chalk');
var Promise = Promise || require('es6-promise').Promise;
var connectivity = require('connectivity');
var templateConfig = require('./templates.json');
var ObjectAssign = require('object-assign-deep');
var configFile = utils.getConfigFromFile(process.cwd());

var defaults = {
    tags: false,
    changelogFilename: 'CHANGELOG.md',
    dataSource: 'issues', // || commits
    onlyMilestones: false,
    milestoneMatch: 'Release {{tag_name}}',
    draft: false,
    force: false,
    prefix: '',
    includeMessages: 'commits', // || merges || all
    prerelease: false,
    dateZero: new Date(0),
    generate: false,
    override: false,
    ignoreLabels: false, // || array of labels
    ignoreIssuesWith: false, // || array of labels
    template: templateConfig,
    groupBy: false
};

/**
 * Edit a release from a given tag (in the options)
 *
 * @since 0.5.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 * @param  {number} releaseId The id of the release to edit
 * @param  {Object} releaseOptions The options to build the release:
 * @example
 * {
 *   "tag_name": "v1.0.0",
 *   "target_commitish": "master",
 *   "name": "v1.0.0",
 *   "body": "Description of the release",
 *   "draft": false,
 *   "prerelease": false
 * }
 *
 * @return {Promise}
 */
function editRelease(gren, releaseId, releaseOptions) {
    var loaded = utils.task(gren, 'Updating latest release');

    return gren.repo.updateRelease(releaseId, releaseOptions)
        .then(function(response) {
            loaded();

            var release = response.data;

            console.log(chalk.green(release.name + ' has been successfully updated!'));

            return release;
        });
}

/**
 * Create a release from a given tag (in the options)
 *
 * @since 0.1.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 * @param  {Object} releaseOptions The options to build the release:
 * @example {
 *   "tag_name": "1.0.0",
 *   "target_commitish": "master",
 *   "name": "v1.0.0",
 *   "body": "Description of the release",
 *   "draft": false,
 *   "prerelease": false
 * }
 *
 * @return {Promise}
 */
function createRelease(gren, releaseOptions) {
    var loaded = utils.task(gren, 'Preparing the release');

    return gren.repo.createRelease(releaseOptions)
        .then(function(response) {
            loaded();
            var release = response.data;

            console.log(chalk.green(release.name + ' has been successfully created!'));

            return release;
        });
}

/**
 * Creates the options to make the release
 *
 * @since 0.2.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 * @param  {Object[]} tags The collection of tags
 *
 * @return {Promise}
 */
function prepareRelease(gren, block) {
    var releaseOptions = {
        tag_name: block.release,
        name: block.name,
        body: block.body,
        draft: gren.options.draft,
        prerelease: gren.options.prerelease
    };

    if (block.id) {
        if (!gren.options.override) {
            console.warn(chalk.black(chalk.bgYellow('Skipping ' + block.release + ' (use --override to replace it)')));

            return Promise.resolve();
        }

        return editRelease(gren, block.id, releaseOptions);
    }

    return createRelease(gren, releaseOptions);
}

/**
 * Get the tags information from the given ones, and adds
 * the next one in case only one is given
 *
 * @since 0.5.0
 * @private
 *
 * @param  {Array|string} selectedTags
 * @param  {Object[]} tags
 *
 * @return {Boolean|Array}
 */
function getSelectedTags(optionTags, tags) {
    if (optionTags.indexOf('all') >= 0) {
        return tags;
    }

    if (!optionTags.length) {
        return false;
    }

    var selectedTags = [].concat(optionTags);

    return tags.filter(function(tag, index) {
        var isSelectedTag = selectedTags.indexOf(tag.name) !== -1;

        if (isSelectedTag && selectedTags.length === 1 && tags[index + 1]) {
            selectedTags.push(tags[index + 1].name);
        }
        return isSelectedTag;
    }).slice(0, 2);
}

/**
 * Get all the tags of the repo
 *
 * @since 0.1.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 *
 * @return {Promise}
 */
function getLastTags(gren, releases) {
    var loaded = utils.task(gren, 'Getting tags');

    return gren.repo.listTags()
        .then(function(response) {
            loaded();

            var tags = response.data;
            var filteredTags = (getSelectedTags(gren.options.tags, tags) || [tags[0], tags[1]])
                .filter(Boolean)
                .map(function(tag) {
                    var tagRelease = releases && releases.filter(function(release) {
                        return release.tag_name === tag.name;
                    })[0] || false;
                    var releaseId = tagRelease ? tagRelease.id : null;

                    return {
                        tag: tag,
                        releaseId: releaseId
                    };
                });

            console.log('Tags found: ' + filteredTags.map(function(tag) {
                return tag.tag.name;
            }).join(', '));

            return filteredTags;
        });
}

/**
 * Get the dates of the last two tags
 *
 * @since 0.1.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 * @param  {Object[]} tags List of all the tags in the repo
 *
 * @return {Promise[]}     The promises which returns the dates
 */
function getTagDates(gren, tags) {
    return tags.map(function(tag) {
        return gren.repo.getCommit(tag.tag.commit.sha)
            .then(function(response) {
                return {
                    id: tag.releaseId,
                    name: tag.tag.name,
                    date: response.data.committer.date
                };
            });
    });
}

/**
 * Get all releases
 *
 * @since 0.5.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 *
 * @return {Promise} The promise which resolves an array of releases
 */
function getListReleases(gren) {
    var loaded = utils.task(gren, 'Getting the list of releases');

    return gren.repo.listReleases()
        .then(function(response) {
            loaded();

            var releases = response.data;

            process.stdout.write(releases.length + ' releases found\n');

            return releases;
        });
}

/**
 * Return the templated commit message
 *
 * @since 0.1.0
 * @private
 *
 * @param  {string} message
 *
 * @return {string}
 */
function templateCommits(gren, message) {
    return template.generate({
        message: message
    }, gren.options.template.commit);
}

/**
 * Generate the MD template from all the labels of a specific issue
 *
 * @since 0.5.0
 * @private
 *
 * @param  {Object} issue
 *
 * @return {string}
 */
function templateLabels(gren, issue) {
    if (!issue.labels.length && gren.options.template.noLabel) {
        issue.labels.push({name: gren.options.template.noLabel});
    }

    return issue.labels
        .filter(function(label) {
            return gren.options.ignoreLabels.indexOf(label.name) === -1;
        })
        .map(function(label) {
            return template.generate({
                label: label.name
            }, gren.options.template.label);
        }).join('');
}

/**
 * Generate the releases bodies from a release Objects Array
 *
 * @since 0.8.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Array} releases The release Objects Array coming from GitHub
 *
 * @return {string}
 */
function templateReleases(gren, releases) {
    return releases.map(function(release) {
        return template.generate({
            release: release.name,
            date: utils.formatDate(new Date(release.published_at)),
            body: release.body
        }, gren.options.template.release);
    }).join(gren.options.template.releaseSeparator);
}

/**
 * Generate the MD template for each issue
 *
 * @since 0.5.0
 * @private
 *
 * @param  {Object} issue
 *
 * @return {string}
 */
function templateIssue(gren, issue) {
    return template.generate({
        labels: templateLabels(gren, issue),
        name: issue.title,
        text: '#' + issue.number,
        url: issue.html_url
    }, gren.options.template.issue);
}

/**
 * Generate the Changelog issues body template
 *
 * @since 0.5.0
 * @private
 *
 * @param  {Object[]} blocks
 *
 * @return {string}
 */
function templateIssueBody(body, rangeBody) {
    return (body.length ? body.join('\n') : rangeBody || '*No changelog for this release.*') + '\n';
}

/**
 * Generates the template for the groups
 *
 * @since  0.8.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Object} groups The groups to template e.g.
 * {
 *     'bugs': [{...}, {...}, {...}]
 * }
 *
 * @return {string}
 */
function templateGroups(gren, groups) {
    return Object.keys(groups).map(function(group) {
        var heading = template.generate({
            heading: group
        }, gren.options.template.group);
        var body = groups[group].join('\n');

        return heading + '\n' + body;
    });
}

/**
 * Return a commit messages generated body
 *
 * @since 0.1.0
 * @private
 *
 * @param  {string} message
 *
 * @return {string}
 */
function generateCommitsBody(gren, messages) {
    messages.length === 1 && messages.push(null);
    return messages
        .slice(0, -1)
        .filter(function(message) {
            var messageType = gren.options.includeMessages;
            var filterMap = {
                merges: function(message) {
                    return message.match(/^merge/i);
                },
                commits: function(message) {
                    return !message.match(/^merge/i);
                },
                all: function() {
                    return true;
                }
            };

            if (filterMap[messageType]) {
                return filterMap[messageType](message);
            }

            return filterMap.commits(message);
        })
        .map(templateCommits.bind(null, gren))
        .join('\n');
}

/**
 * Transforms the commits to commit messages
 *
 * @since 0.1.0
 * @private
 *
 * @param  {Object[]} commits The array of object containing the commits
 *
 * @return {String[]}
 */
function commitMessages(commits) {
    return commits.map(function(commitObject) {
        return commitObject.commit.message;
    });
}

/**
 * Gets all the commits between two dates
 *
 * @since 0.1.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 * @param  {string} since The since date in ISO
 * @param  {string} until The until date in ISO
 *
 * @return {Promise}      The promise which resolves the [Array] commit messages
 */
function getCommitsBetweenTwo(gren, since, until) {
    process.stdout.write(chalk.green('Get commits between ' + utils.formatDate(new Date(since)) + ' and ' + utils.formatDate(new Date(until)) + '\n'));

    var options = {
        since: since,
        until: until,
        per_page: 100
    };

    return gren.repo.listCommits(options)
        .then(function(response) {
            return commitMessages(response.data);
        });
}

/**
 * Get the blocks of commits based on release dates
 *
 * @since 0.5.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Array} releaseRanges The array of date ranges
 *
 * @return {Promise[]}
 */
function getCommitBlocks(gren, releaseRanges) {
    console.log(chalk.blue('\nCreating the body blocks from commits:'));

    return Promise.all(
        releaseRanges
            .map(function(range) {
                return getCommitsBetweenTwo(gren, range[1].date, range[0].date)
                    .then(function(commits) {
                        return {
                            id: range[0].id,
                            name: gren.options.prefix + range[0].name,
                            release: range[0].name,
                            published_at: range[0].date,
                            body: generateCommitsBody(gren, commits) + '\n'
                        };
                    });
            })
    );
}

/**
 * Compare the ignored labels with the passed ones
 *
 * @since 0.6.0
 * @private
 *
 * @param  {Array} ignoreLabels    The labels to ignore
 * @param  {Array} labels   The labels to check
 *
 * @return {boolean}    If the labels array contain any of the ignore ones
 */
function compareIssueLabels(ignoreLabels, labels) {
    return ignoreLabels
        .reduce(function(carry, ignoredLabel) {
            return carry && labels.map(function(label) {
                return label.name;
            }).indexOf(ignoredLabel) === -1;
        }, true);
}

/**
 * Filter the issue based on gren options and labels
 *
 * @since 0.9.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Object} issue
 *
 * @return {Boolean}
 */
function filterIssue(gren, issue) {
    return !issue.pull_request && compareIssueLabels(gren.options.ignoreIssuesWith, issue.labels) &&
        !(gren.options.onlyMilestones || gren.options.dataSource === 'milestones' && !issue.milestone);
}

/**
 * Get all the closed issues from the current repo
 *
 * @since 0.5.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren The gren object
 * @param  {Array} releaseRanges The array of date ranges
 *
 * @return {Promise} The promise which resolves the list of the issues
 */
function getClosedIssues(gren, releaseRanges) {
    var loaded = utils.task(gren, 'Getting all closed issues');

    return gren.issues.listIssues({
        state: 'closed',
        since: releaseRanges[releaseRanges.length - 1][1].date
    })
    .then(function(response) {
        loaded();

        var filteredIssues = response.data.filter(filterIssue.bind(null, gren));

        process.stdout.write(filteredIssues.length + ' issues found\n');

        return filteredIssues;
    });
}

/**
 * Group the issues based on their first label
 *
 * @since 0.8.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Array} issues
 *
 * @return {string}
 */
function groupByLabel(gren, issues) {
    var groups = [];

    issues.forEach(function(issue) {
        if (!issue.labels.length && gren.options.template.noLabel) {
            issue.labels.push({name: gren.options.template.noLabel});
        }

        var labelName = issue.labels[0].name;

        if (!groups[labelName]) {
            groups[labelName] = [];
        }

        groups[labelName].push(templateIssue(gren, issue));
    });

    return templateGroups(gren, utils.sortObject(groups));
}

/**
 * Create groups of issues based on labels
 *
 * @since  0.8.0
 * @private
 *
 * @param {GithubReleaseNotes} gren
 * @param  {Array} issues The array of all the issues.
 *
 * @return {Array}
 */
function groupBy(gren, issues) {
    var groupBy = gren.options.groupBy;

    if (!groupBy) {
        return issues.map(templateIssue.bind(null, gren));
    }

    if (groupBy === 'label') {
        return groupByLabel(gren, issues);
    }

    if (typeof groupBy !== 'object') {
        throw chalk.red('The option for groupBy is invalid, please check the documentation');
    }

    var allLabels = Object.keys(groupBy).reduce(function(carry, group) {
        return carry.concat(groupBy[group]);
    }, []);

    var groups = Object.keys(groupBy).reduce(function(carry, group) {
        var groupIssues = issues.filter(function(issue) {
            if (!issue.labels.length && gren.options.template.noLabel) {
                issue.labels.push({name: gren.options.template.noLabel});
            }

            return issue.labels.some(function(label) {
                var isOtherLabel = groupBy[group].indexOf('...') !== -1 && allLabels.indexOf(label.name) === -1;

                return groupBy[group].indexOf(label.name) !== -1 || isOtherLabel;
            });
        }).map(templateIssue.bind(null, gren));

        if (groupIssues.length) {
            carry[group] = groupIssues;
        }

        return carry;
    }, {});

    return templateGroups(gren, groups);
}

/**
 * Filter the issue based on the date range, or if is in the release
 * milestone.
 *
 * @since 0.9.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Array} range The release ranges
 * @param  {Object} issue GitHub issue
 *
 * @return {Boolean}
 */
function filterBlockIssue(gren, range, issue) {
    if (gren.options.dataSource === 'milestones') {
        return gren.options.milestoneMatch.replace('{{tag_name}}', range[0].name) === issue.milestone.title;
    }

    return utils.isInRange(
        Date.parse(issue.closed_at),
        Date.parse(range[1].date),
        Date.parse(range[0].date)
    );
}

/**
 * Get the blocks of issues based on release dates
 *
 * @since 0.5.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Array} releaseRanges The array of date ranges
 *
 * @return {Promise[]}
 */
function getIssueBlocks(gren, releaseRanges) {
    console.log('Creating the body blocks from releases:');

    return getClosedIssues(gren, releaseRanges)
        .then(function(issues) {
            return releaseRanges
                .map(function(range) {
                    var filteredIssues = issues.filter(filterBlockIssue.bind(null, gren, range));
                    var body = (!range[0].body || gren.options.override) && groupBy(gren, filteredIssues);

                    return {
                        id: range[0].id,
                        release: range[0].name,
                        name: gren.options.prefix + range[0].name,
                        published_at: range[0].date,
                        body: templateIssueBody(body, range[0].body)
                    };
                });
        });
}

/**
 * Sort releases by dates
 *
 * @since 0.5.0
 * @private
 *
 * @param {Array} releaseDates
 *
 * @return {Array}
 */
function sortReleasesByDate(releaseDates) {
    return releaseDates.sort(function(release1, release2) {
        return new Date(release2.date) - new Date(release1.date);
    });
}

/**
 * Create the ranges of release dates
 *
 * @since 0.5.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {Array} releaseDates The release dates
 *
 * @return {Array}
 */
function createReleaseRanges(gren, releaseDates) {
    var ranges = [];
    var range = 2;
    var sortedReleaseDates = sortReleasesByDate(releaseDates);

    if (sortedReleaseDates.length === 1) {
        sortedReleaseDates.push({
            id: 0,
            date: new Date(0)
        });
    }

    for (var i = 0; i < sortedReleaseDates.length - 1; i++) {
        ranges.push(sortedReleaseDates.slice(i, i + range));
    }

    return ranges;
}

/**
 * Generate release blocks based on issues or commit messages
 * depending on the option.
 *
 * @param  {GithubReleaseNotes} gren
 *
 * @return {Promise} Resolving the release blocks
 */
function getReleaseBlocks(gren) {
    var loaded;
    var dataSource = {
        issues: getIssueBlocks,
        commits: getCommitBlocks,
        milestones: getIssueBlocks
    };

    return getListReleases(gren)
        .then(function(releases) {
            return getLastTags(gren, releases.length ? releases : false);
        })
        .then(function(tags) {
            loaded = utils.task(gren, 'Getting the tag dates ranges');

            return Promise.all(getTagDates(gren, tags));
        })
        .then(function(releaseDates) {
            loaded();

            return dataSource[gren.options.dataSource](
                gren,
                createReleaseRanges(gren, releaseDates)
            );
        });
}

/**
 * Check if the changelog file exists
 *
 * @since 0.8.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 *
 * @return {Promise}
 */
function checkChangelogFile(gren) {
    var filePath = process.cwd() + '/' + gren.options.changelogFilename;

    if (fs.existsSync(filePath) && !gren.options.override) {
        Promise.reject(chalk.red('Looks like there is already a changelog, to override it use --override'));
    }

    return Promise.resolve();
}

/**
 * Create the changelog file
 *
 * @since 0.8.0
 * @private
 *
 * @param  {GithubReleaseNotes} gren
 * @param  {string} body The body of the file
 */
function createChangelog(gren, body) {
    var filePath = process.cwd() + '/' + gren.options.changelogFilename;

    fs.writeFileSync(filePath, gren.options.template.changelogTitle + body);

    console.log(chalk.green('\nChangelog created!'));
}

/**
 * Generate the GithubReleaseNotes getting the options from the git config
 *
 * @since 0.5.0
 * @private
 *
 * @return {Promise[]}
 */
function generateOptions(options) {
    return Promise.all([
        options.username && options.repo ? Promise.resolve({ username: options.username, repo: options.repo }) : githubInfo.repo(),
        options.token ? Promise.resolve({ token: options.token }) : githubInfo.token()
    ]);
}

/**
 * Check if there is connectivity
 *
 * @since 0.5.0
 * @private
 *
 * @return {Promise}
 */
function hasNetwork() {
    return new Promise(function(resolve) {
        connectivity(function(isOnline) {
            if (!isOnline) {
                console.warn(chalk.yellow('WARNING: Looks like you don\'t have network connectivity!'));
            }

            resolve();
        });
    });
}

/**
 * @param  {Object} [options] The options of the module
 *
 * @since  0.1.0
 * @public
 *
 * @constructor
 */
function GithubReleaseNotes(options) {
    this.options = ObjectAssign({}, defaults, configFile, options || utils.getBashOptions(process.argv));
    this.options.tags = utils.convertStringToArray(this.options.tags);
    this.options.ignoreLabels = utils.convertStringToArray(this.options.ignoreLabels);
    this.options.ignoreIssuesWith = utils.convertStringToArray(this.options.ignoreIssuesWith);
    this.repo = null;
    this.issues = null;
}

/**
 * Initialise the GithubReleaseNotes module, create the options and run
 * a given module method
 *
 * @since 0.5.0
 * @public
 *
 * @param  {function} action
 *
 * @return {Promise} The generated options
 */
GithubReleaseNotes.prototype.init = function() {
    var gren = this;

    gren.tasks = [];

    return hasNetwork()
        .then(function() {
            return generateOptions(gren.options);
        })
        .then(function(optionData) {
            gren.options = ObjectAssign(...optionData, gren.options);

            if (!gren.options.token) {
                throw chalk.red('You need to provide the token');
            }

            var githubApi = new Github({
                token: gren.options.token
            });

            gren.repo = githubApi.getRepo(gren.options.username, gren.options.repo);
            gren.issues = githubApi.getIssues(gren.options.username, gren.options.repo);
        });
};

/**
 * Get All the tags, get the dates, get the commits between those dates and prepeare the release
 *
 * @since  0.1.0
 * @public
 *
 * @return {Promise}
 */
GithubReleaseNotes.prototype.release = function() {
    utils.printTask('\nRelease');

    var gren = this;

    return getReleaseBlocks(this)
        .then(function(blocks) {
            throw blocks;

            return blocks.reduce(function(carry, block) {
                return carry.then(prepareRelease.bind(null, gren, block));
            }, Promise.resolve());
        });
};

/**
 * Generate the Changelog based on the github releases, or
 * from fresh generated releases.
 *
 * @since 0.5.0
 *
 * @public
 *
 * @param {string} type The type of changelog
 */
GithubReleaseNotes.prototype.changelog = function() {
    utils.printTask('\nChangelog');

    var gren = this;

    return checkChangelogFile(this)
        .then(function() {
            if (gren.options.generate) {
                return getReleaseBlocks(gren);
            }

            return getListReleases(gren);
        })
        .then(function(releases) {
            if (releases.length === 0) {
                throw chalk.red('There are no releases, use --generate to create release notes, or run the release command.');
            }

            return Promise.resolve(releases);
        })
        .then(function(releases) {
            createChangelog(gren, templateReleases(gren, releases));
        });
};

module.exports = GithubReleaseNotes;
