/* @flow */
import {it, describe} from 'mocha';
import * as sinon from 'sinon';
import {assert} from 'chai';

import {makeSureItFails} from '../helpers.js';
import defaultDocsCommand, {url} from '../../../src/cmd/docs.js';

describe('docs', () => {
  it('passes the correct url to docs', () => {
    const openUrl = sinon.spy((urlToOpen, callback) => callback(null));
    return defaultDocsCommand({}, {openUrl}).then(() => {
      sinon.assert.calledWith(openUrl, url);
    });
  });

  it('throws an error when open fails', () => {
    const openUrl = sinon.spy((urlToOpen, callback) => callback(
      new Error('pretends this is an error from open()')
    ));
    return defaultDocsCommand({}, {openUrl})
      .then(makeSureItFails()).catch((error) => {
        assert.match(error.message, /error from open()/);
      });
  });
});
