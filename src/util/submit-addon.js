/* @flow */
import { createWriteStream, promises as fsPromises } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';

// eslint-disable-next-line no-shadow
import fetch, { FormData, fileFromSync, Response } from 'node-fetch';
import { SignJWT } from 'jose';

import { createLogger } from './../util/logger.js';

const log = createLogger(import.meta.url);

export type SignResult = {|
  id: string,
  downloadedFiles: Array<string>,
|};

export interface ApiAuth {
  getAuthHeader(): Promise<string>;
}

export class JwtApiAuth {
  #apiKey: string;
  #apiSecret: string;
  #apiJwtExpiresIn: number;

  constructor({
    apiKey,
    apiSecret,
    apiJwtExpiresIn = 60 * 5, // 5 minutes
  }: {
    apiKey: string,
    apiSecret: string,
    apiJwtExpiresIn?: number,
  }) {
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#apiJwtExpiresIn = apiJwtExpiresIn;
  }

  async signJWT(): Promise<string> {
    return (
      new SignJWT({ iss: this.#apiKey })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        // jose expects either:
        // a number, which is treated an absolute timestamp - so must be after now, or
        // a string, which is parsed as a relative time from now.
        .setExpirationTime(`${this.#apiJwtExpiresIn}seconds`)
        .sign(Uint8Array.from(Buffer.from(this.#apiSecret, 'utf8')))
    );
  }

  async getAuthHeader(): Promise<string> {
    const authToken = await this.signJWT();
    return `JWT ${authToken}`;
  }
}

type ClientConstructorParams = {|
  apiAuth: ApiAuth,
  baseUrl: URL,
  validationCheckInterval?: number,
  validationCheckTimeout?: number,
  approvalCheckInterval?: number,
  approvalCheckTimeout?: number,
  downloadDir?: string,
  userAgentString: string,
|};

export default class Client {
  apiAuth: ApiAuth;
  apiUrl: URL;
  validationCheckInterval: number;
  validationCheckTimeout: number;
  approvalCheckInterval: number;
  approvalCheckTimeout: number;
  downloadDir: string;
  userAgentString: string;

  constructor({
    apiAuth,
    baseUrl,
    validationCheckInterval = 1000,
    validationCheckTimeout = 300000, // 5 minutes.
    approvalCheckInterval = 1000,
    approvalCheckTimeout = 900000, // 15 minutes.
    downloadDir = process.cwd(),
    userAgentString,
  }: ClientConstructorParams) {
    this.apiAuth = apiAuth;
    if (!baseUrl.pathname.endsWith('/')) {
      baseUrl = new URL(baseUrl.href);
      baseUrl.pathname += '/';
    }
    this.apiUrl = new URL('addons/', baseUrl);
    this.validationCheckInterval = validationCheckInterval;
    this.validationCheckTimeout = validationCheckTimeout;
    this.approvalCheckInterval = approvalCheckInterval;
    this.approvalCheckTimeout = approvalCheckTimeout;
    this.downloadDir = downloadDir;
    this.userAgentString = userAgentString;
  }

  fileFromSync(path: string): File {
    return fileFromSync(path);
  }

  nodeFetch(
    url: URL,
    {
      method,
      headers,
      body,
    }: {
      method: string,
      headers: { [key: string]: string },
      body?: typeof FormData | string,
    }
  ): Promise<typeof Response> {
    return fetch(url, { method, headers, body });
  }

  async doUploadSubmit(xpiPath: string, channel: string): Promise<string> {
    const url = new URL('upload/', this.apiUrl);
    const formData = new FormData();
    formData.set('channel', channel);
    formData.set('upload', this.fileFromSync(xpiPath));
    const { uuid } = await this.fetchJson(url, 'POST', formData);
    return this.waitForValidation(uuid);
  }

  waitRetry(
    successFunc: (detailResponseData: any) => string | null,
    checkUrl: URL,
    checkInterval: number,
    abortInterval: number,
    context: string
  ): Promise<string> {
    let checkTimeout;

    return new Promise((resolve, reject) => {
      const abortTimeout = setTimeout(() => {
        clearTimeout(checkTimeout);
        reject(new Error(`${context}: timeout.`));
      }, abortInterval);

      const pollStatus = async () => {
        try {
          const responseData = await this.fetchJson(
            checkUrl,
            'GET',
            undefined,
            'Getting details failed.'
          );

          const success = successFunc(responseData);
          if (success) {
            clearTimeout(abortTimeout);
            resolve(success);
          } else {
            // Still in progress, so wait for a while and try again.
            checkTimeout = setTimeout(pollStatus, checkInterval);
          }
        } catch (err) {
          clearTimeout(abortTimeout);
          reject(err);
        }
      };

      pollStatus();
    });
  }

  waitForValidation(uuid: string): Promise<string> {
    log.info('Waiting for Validation...');
    return this.waitRetry(
      (detailResponseData): string | null => {
        if (!detailResponseData.processed) {
          return null;
        }

        log.info('Validation results:', detailResponseData.validation);
        if (detailResponseData.valid) {
          return detailResponseData.uuid;
        }

        log.info('Validation failed.');
        throw new Error(
          'Validation failed, open the following URL for more information: ' +
            `${detailResponseData.url}`
        );
      },
      new URL(`upload/${uuid}/`, this.apiUrl),
      this.validationCheckInterval,
      this.validationCheckTimeout,
      'Validation'
    );
  }

  async doNewAddonSubmit(uuid: string, metaDataJson: Object): Promise<any> {
    const url = new URL('addon/', this.apiUrl);
    const jsonData = {
      ...metaDataJson,
      version: { upload: uuid, ...metaDataJson.version },
    };
    return this.fetchJson(url, 'POST', JSON.stringify(jsonData));
  }

  doNewAddonOrVersionSubmit(
    addonId: string,
    uuid: string,
    metaDataJson: Object
  ): Promise<typeof Response> {
    const url = new URL(`addon/${addonId}/`, this.apiUrl);
    const jsonData = {
      ...metaDataJson,
      version: { upload: uuid, ...metaDataJson.version },
    };
    return this.fetch(url, 'PUT', JSON.stringify(jsonData));
  }

  waitForApproval(addonId: string, versionId: number): Promise<string> {
    log.info('Waiting for Approval...');
    return this.waitRetry(
      (detailResponseData): string | null => {
        const { file } = detailResponseData;
        if (file && file.status === 'public') {
          return file.url;
        }

        return null;
      },
      new URL(`addon/${addonId}/versions/${versionId}/`, this.apiUrl),
      this.approvalCheckInterval,
      this.approvalCheckTimeout,
      'Approval'
    );
  }

  async fetchJson(
    url: URL,
    method: string = 'GET',
    body?: typeof FormData | string,
    errorMsg: string = 'Bad Request'
  ): Promise<any> {
    const response = await this.fetch(url, method, body);
    if (response.status < 200 || response.status >= 500) {
      throw new Error(
        `${errorMsg}: ${response.statusText || response.status}.`
      );
    }
    const data = await response.json();

    if (!response.ok) {
      log.info('Server Response:', data);
      throw new Error(
        `${errorMsg}: ${response.statusText || response.status}.`
      );
    }
    return data;
  }

  async fetch(
    url: URL,
    method: string = 'GET',
    body?: typeof FormData | string
  ): Promise<typeof Response> {
    log.info(`Fetching URL: ${url.href}`);
    let headers = {
      Authorization: await this.apiAuth.getAuthHeader(),
      Accept: 'application/json',
      'User-Agent': this.userAgentString,
    };
    if (typeof body === 'string') {
      headers = {
        ...headers,
        'Content-Type': 'application/json',
      };
    }
    return this.nodeFetch(url, { method, body, headers });
  }

  async downloadSignedFile(fileUrl: URL, addonId: string): Promise<SignResult> {
    const filename = fileUrl.pathname.split('/').pop(); // get the name from fileUrl
    const dest = `${this.downloadDir}/${filename}`;
    try {
      const response = await this.fetch(fileUrl);
      if (!response.ok || !response.body) {
        throw new Error(`response status was ${response.status}`);
      }
      await this.saveToFile(response.body, dest);
    } catch (error) {
      log.info(`Download of signed xpi failed: ${error}.`);
      throw new Error(`Downloading ${filename} failed`);
    }
    return {
      id: addonId,
      downloadedFiles: [filename],
    };
  }

  async saveToFile(
    contents: typeof Response.body,
    destPath: string
  ): Promise<any> {
    return promisify(pipeline)(contents, createWriteStream(destPath));
  }

  async postNewAddon(
    xpiPath: string,
    channel: string,
    savedIdPath: string,
    metaDataJson: Object,
    saveIdToFileFunc: (string, string) => Promise<void> = saveIdToFile
  ): Promise<SignResult> {
    const uploadUuid = await this.doUploadSubmit(xpiPath, channel);

    const versionObject =
      channel === 'listed' ? 'current_version' : 'latest_unlisted_version';
    const {
      guid: addonId,
      [versionObject]: { id: newVersionId },
    } = await this.doNewAddonSubmit(uploadUuid, metaDataJson);

    await saveIdToFileFunc(savedIdPath, addonId);
    log.info(`Generated extension ID: ${addonId}.`);
    log.info('You must add the following to your manifest:');
    log.info(`"browser_specific_settings": {"gecko": {"id": "${addonId}"}}`);

    const fileUrl = new URL(await this.waitForApproval(addonId, newVersionId));

    return this.downloadSignedFile(fileUrl, addonId);
  }

  async putVersion(
    xpiPath: string,
    channel: string,
    addonId: string,
    metaDataJson: Object
  ): Promise<SignResult> {
    const uploadUuid = await this.doUploadSubmit(xpiPath, channel);

    await this.doNewAddonOrVersionSubmit(addonId, uploadUuid, metaDataJson);

    const url = new URL(
      `addon/${addonId}/versions/?filter=all_with_unlisted`,
      this.apiUrl
    );
    const {
      results: [{ id: newVersionId }],
    } = await this.fetchJson(url);

    const fileUrl = new URL(await this.waitForApproval(addonId, newVersionId));

    return this.downloadSignedFile(fileUrl, addonId);
  }
}

type signAddonParams = {|
  apiKey: string,
  apiSecret: string,
  amoBaseUrl: string,
  timeout: number,
  id?: string,
  xpiPath: string,
  downloadDir: string,
  channel: string,
  savedIdPath: string,
  metaDataJson?: Object,
  userAgentString: string,
  SubmitClient?: typeof Client,
  ApiAuthClass?: typeof JwtApiAuth,
|};

export async function signAddon({
  apiKey,
  apiSecret,
  amoBaseUrl,
  timeout,
  id,
  xpiPath,
  downloadDir,
  channel,
  savedIdPath,
  metaDataJson = {},
  userAgentString,
  SubmitClient = Client,
  ApiAuthClass = JwtApiAuth,
}: signAddonParams): Promise<SignResult> {
  try {
    const stats = await fsPromises.stat(xpiPath);

    if (!stats.isFile()) {
      throw new Error(`not a file: ${xpiPath}`);
    }
  } catch (statError) {
    throw new Error(`error with ${xpiPath}: ${statError}`);
  }

  let baseUrl;
  try {
    baseUrl = new URL(amoBaseUrl);
  } catch (err) {
    throw new Error(`Invalid AMO API base URL: ${amoBaseUrl}`);
  }

  const client = new SubmitClient({
    apiAuth: new ApiAuthClass({ apiKey, apiSecret }),
    baseUrl,
    validationCheckTimeout: timeout,
    approvalCheckTimeout: timeout,
    downloadDir,
    userAgentString,
  });

  // We specifically need to know if `id` has not been passed as a parameter because
  // it's the indication that a new add-on should be created, rather than a new version.
  if (id === undefined) {
    return client.postNewAddon(xpiPath, channel, savedIdPath, metaDataJson);
  }

  return client.putVersion(xpiPath, channel, id, metaDataJson);
}

export async function saveIdToFile(
  filePath: string,
  id: string
): Promise<void> {
  await fsPromises.writeFile(
    filePath,
    [
      '# This file was created by https://github.com/mozilla/web-ext',
      '# Your auto-generated extension ID for addons.mozilla.org is:',
      id.toString(),
    ].join('\n')
  );

  log.debug(`Saved auto-generated ID ${id} to ${filePath}`);
}
