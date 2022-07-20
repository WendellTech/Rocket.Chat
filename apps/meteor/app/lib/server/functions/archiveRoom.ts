import { Meteor } from 'meteor/meteor';

import { Rooms, Messages, Subscriptions } from '../../../models/server';
import { callbacks } from '../../../../lib/callbacks';

export const archiveRoom = function (rid: string, roomCollectionUpdated: boolean = false): void {
	if (!roomCollectionUpdated) {
		Rooms.archiveById(rid);
	}
	Subscriptions.archiveByRoomId(rid);
	Messages.createRoomArchivedByRoomIdAndUser(rid, Meteor.user());

	callbacks.run('afterRoomArchived', Rooms.findOneById(rid), Meteor.user());
};
