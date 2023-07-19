import type { MatchKeysAndValues } from 'mongodb';
import { Settings, ImportData, Imports } from '@rocket.chat/models';
import type { IImport, IImportRecordType, IImportData, IImportChannel, IImportUser, IImportProgress } from '@rocket.chat/core-typings';
import AdmZip from 'adm-zip';

import { Progress } from './ImporterProgress';
import { ImporterWebsocket } from './ImporterWebsocket';
import type { ImporterInfo } from '../definitions/ImporterInfo';
import { ProgressStep, ImportPreparingStartedStates } from '../../lib/ImporterProgressStep';
import { Logger } from '../../../logger/server';
import { ImportDataConverter } from './ImportDataConverter';
import { t } from '../../../utils/lib/i18n';
import { Selection, SelectionChannel, SelectionUser } from '..';

type OldSettings = {
	allowedDomainList?: string | null;
	allowUsernameChange?: boolean | null;
	maxFileSize?: number | null;
	mediaTypeWhiteList?: string | null;
	mediaTypeBlackList?: string | null;
};

/**
 * Base class for all of the importers.
 */
export class Importer {
	private reportProgressHandler: ReturnType<typeof setTimeout> | undefined;

	protected AdmZip = AdmZip;

	protected converter: ImportDataConverter;

	protected info: ImporterInfo;

	protected logger: Logger;

	protected users: Record<string, any>;

	protected channels: Record<string, any>;

	protected messages: Record<string, any>;

	protected oldSettings: OldSettings;

	public importRecord: IImport;

	public progress: Progress;

	constructor(info: ImporterInfo, importRecord: IImport) {
		if (!info.key || !info.importer) {
			throw new Error('Information passed in must be a valid ImporterInfo instance.');
		}

		this.converter = new ImportDataConverter();

		this.startImport = this.startImport.bind(this);
		this.getProgress = this.getProgress.bind(this);
		this.updateProgress = this.updateProgress.bind(this);
		this.addCountToTotal = this.addCountToTotal.bind(this);
		this.addCountCompleted = this.addCountCompleted.bind(this);
		this.updateRecord = this.updateRecord.bind(this);

		this.info = info;

		this.logger = new Logger(`${this.info.name} Importer`);
		this.converter.setLogger(this.logger);

		this.progress = new Progress(this.info.key, this.info.name);
		this.importRecord = importRecord;
		this.users = {};
		this.channels = {};
		this.messages = {};
		this.oldSettings = {};

		this.progress.step = this.importRecord.status;
		this.reloadCount();

		this.logger.debug(`Constructed a new ${this.info.name} Importer.`);
	}

	/**
	 * Registers the file name and content type on the import operation
	 */
	async startFileUpload(fileName: string, contentType?: string): Promise<IImport> {
		await this.updateProgress(ProgressStep.UPLOADING);
		return this.updateRecord({ file: fileName, ...(contentType ? { contentType } : {}) });
	}

	/**
	 * Takes the uploaded file and extracts the users, channels, and messages from it.
	 *
	 * @param {string} _fullFilePath the full path of the uploaded file
	 * @returns {Progress} The progress record of the import.
	 */
	async prepareUsingLocalFile(_fullFilePath: string): Promise<Progress> {
		return this.updateProgress(ProgressStep.PREPARING_STARTED);
	}

	/**
	 * Starts the import process. The implementing method should defer
	 * as soon as the selection is set, so the user who started the process
	 * doesn't end up with a "locked" UI while Meteor waits for a response.
	 * The returned object should be the progress.
	 *
	 * @param {Selection} importSelection The selection data.
	 * @returns {Progress} The progress record of the import.
	 */
	async startImport(importSelection: Selection, startedByUserId: string): Promise<Progress> {
		if (!(importSelection instanceof Selection)) {
			throw new Error(`Invalid Selection data provided to the ${this.info.name} importer.`);
		} else if (importSelection.users === undefined) {
			throw new Error(`Users in the selected data wasn't found, it must but at least an empty array for the ${this.info.name} importer.`);
		} else if (importSelection.channels === undefined) {
			throw new Error(
				`Channels in the selected data wasn't found, it must but at least an empty array for the ${this.info.name} importer.`,
			);
		}
		if (!startedByUserId) {
			throw new Error('You must be logged in to do this.');
		}

		await this.updateProgress(ProgressStep.IMPORTING_STARTED);
		this.reloadCount();
		const started = Date.now();

		const beforeImportFn = async (data: IImportData, type: IImportRecordType) => {
			if (this.importRecord.valid === false) {
				this.converter.aborted = true;
				throw new Error('The import operation is no longer valid.');
			}

			switch (type) {
				case 'channel': {
					if (!importSelection.channels) {
						return true;
					}

					const channelData = data as IImportChannel;

					const id = channelData.t === 'd' ? '__directMessages__' : channelData.importIds[0];
					for (const channel of importSelection.channels) {
						if (channel.channel_id === id) {
							return channel.do_import;
						}
					}

					return false;
				}
				case 'user': {
					if (!importSelection.users) {
						return true;
					}
					if (importSelection.users.length === 0 && this.info.key === 'api') {
						return true;
					}

					const userData = data as IImportUser;

					const id = userData.importIds[0];
					for (const user of importSelection.users) {
						if (user.user_id === id) {
							return user.do_import;
						}
					}

					return false;
				}
			}

			return true;
		};

		const afterImportFn = async () => {
			await this.addCountCompleted(1);

			if (this.importRecord.valid === false) {
				this.converter.aborted = true;
				throw new Error('The import operation is no longer valid.');
			}
		};

		process.nextTick(async () => {
			await this.backupSettingValues();

			try {
				await this.applySettingValues({});

				await this.updateProgress(ProgressStep.IMPORTING_USERS);
				await this.converter.convertUsers({ beforeImportFn, afterImportFn });

				await this.updateProgress(ProgressStep.IMPORTING_CHANNELS);
				await this.converter.convertChannels(startedByUserId, { beforeImportFn, afterImportFn });

				await this.updateProgress(ProgressStep.IMPORTING_MESSAGES);
				await this.converter.convertMessages({ afterImportFn });

				await this.updateProgress(ProgressStep.FINISHING);

				process.nextTick(async () => {
					await this.converter.clearSuccessfullyImportedData();
				});

				await this.updateProgress(ProgressStep.DONE);
			} catch (e) {
				this.logger.error(e);
				await this.updateProgress(ProgressStep.ERROR);
			} finally {
				await this.applySettingValues(this.oldSettings);
			}

			const timeTook = Date.now() - started;
			this.logger.log(`Import took ${timeTook} milliseconds.`);
		});

		return this.getProgress();
	}

	async backupSettingValues() {
		const allowedDomainList = (await Settings.findOneById('Accounts_AllowedDomainsList'))?.value as string | null;
		const allowUsernameChange = (await Settings.findOneById('Accounts_AllowUsernameChange'))?.value as boolean | null;
		const maxFileSize = (await Settings.findOneById('FileUpload_MaxFileSize'))?.value as number | null;
		const mediaTypeWhiteList = (await Settings.findOneById('FileUpload_MediaTypeWhiteList'))?.value as string | null;
		const mediaTypeBlackList = (await Settings.findOneById('FileUpload_MediaTypeBlackList'))?.value as string | null;

		this.oldSettings = {
			allowedDomainList,
			allowUsernameChange,
			maxFileSize,
			mediaTypeWhiteList,
			mediaTypeBlackList,
		};
	}

	async applySettingValues(settingValues: OldSettings) {
		await Settings.updateValueById('Accounts_AllowedDomainsList', settingValues.allowedDomainList ?? '');
		await Settings.updateValueById('Accounts_AllowUsernameChange', settingValues.allowUsernameChange ?? true);
		await Settings.updateValueById('FileUpload_MaxFileSize', settingValues.maxFileSize ?? -1);
		await Settings.updateValueById('FileUpload_MediaTypeWhiteList', settingValues.mediaTypeWhiteList ?? '*');
		await Settings.updateValueById('FileUpload_MediaTypeBlackList', settingValues.mediaTypeBlackList ?? '');
	}

	getProgress(): Progress {
		return this.progress;
	}

	/**
	 * Updates the progress step of this importer.
	 * It also changes some internal settings at various stages of the import.
	 * This way the importer can adjust user/room information at will.
	 *
	 * @param {ProgressStep} step The progress step which this import is currently at.
	 * @returns {Progress} The progress record of the import.
	 */
	async updateProgress(step: IImportProgress['step']): Promise<Progress> {
		this.progress.step = step;

		this.logger.debug(`${this.info.name} is now at ${step}.`);
		await this.updateRecord({ status: this.progress.step });

		// Do not send the default progress report during the preparing stage - the classes are sending their own report in a different format.
		if (!ImportPreparingStartedStates.includes(this.progress.step)) {
			this.reportProgress();
		}

		return this.progress;
	}

	reloadCount() {
		this.progress.count.total = this.importRecord.count?.total || 0;
		this.progress.count.completed = this.importRecord.count?.completed || 0;
	}

	/**
	 * Adds the passed in value to the total amount of items needed to complete.
	 *
	 * @param {number} count The amount to add to the total count of items.
	 * @returns {Progress} The progress record of the import.
	 */
	async addCountToTotal(count: number): Promise<Progress> {
		this.progress.count.total += count;
		await this.updateRecord({ 'count.total': this.progress.count.total });

		return this.progress;
	}

	/**
	 * Adds the passed in value to the total amount of items completed.
	 *
	 * @param {number} count The amount to add to the total count of finished items.
	 * @returns {Progress} The progress record of the import.
	 */
	async addCountCompleted(count: number): Promise<Progress> {
		this.progress.count.completed += count;

		const range = [ProgressStep.IMPORTING_USERS, ProgressStep.IMPORTING_CHANNELS].includes(this.progress.step) ? 50 : 500;

		// Only update the database every 500 messages (or 50 users/channels)
		// Or the completed is greater than or equal to the total amount
		if (this.progress.count.completed % range === 0 || this.progress.count.completed >= this.progress.count.total) {
			await this.updateRecord({ 'count.completed': this.progress.count.completed });
			this.reportProgress();
		} else if (!this.reportProgressHandler) {
			this.reportProgressHandler = setTimeout(() => {
				this.reportProgress();
			}, 250);
		}

		this.logger.log(`${this.progress.count.completed} messages imported`);

		return this.progress;
	}

	/**
	 * Sends an updated progress to the websocket
	 */
	reportProgress() {
		if (this.reportProgressHandler) {
			clearTimeout(this.reportProgressHandler);
			this.reportProgressHandler = undefined;
		}
		ImporterWebsocket.progressUpdated(this.progress);
	}

	/**
	 * Updates the import record with the given fields being `set`.
	 */
	async updateRecord(fields: MatchKeysAndValues<IImport>): Promise<IImport> {
		if (!this.importRecord) {
			return this.importRecord;
		}

		await Imports.update({ _id: this.importRecord._id }, { $set: fields });
		// #TODO: Remove need for the typecast
		this.importRecord = (await Imports.findOne(this.importRecord._id)) as IImport;

		return this.importRecord;
	}

	async buildSelection(): Promise<Selection> {
		await this.updateProgress(ProgressStep.USER_SELECTION);

		const users = await ImportData.getAllUsersForSelection();
		const channels = await ImportData.getAllChannelsForSelection();
		const hasDM = await ImportData.checkIfDirectMessagesExists();

		const selectionUsers = users.map(
			(u) =>
				new SelectionUser(u.data.importIds[0], u.data.username, u.data.emails[0], Boolean(u.data.deleted), u.data.type === 'bot', true),
		);
		const selectionChannels = channels.map(
			(c) => new SelectionChannel(c.data.importIds[0], c.data.name, Boolean(c.data.archived), true, c.data.t === 'p', c.data.t === 'd'),
		);
		const selectionMessages = await ImportData.countMessages();

		if (hasDM) {
			selectionChannels.push(new SelectionChannel('__directMessages__', t('Direct_Messages'), false, true, true, true));
		}

		const results = new Selection(this.info.name, selectionUsers, selectionChannels, selectionMessages);

		return results;
	}
}
