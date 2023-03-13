import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

import { settings } from '../../../app/settings/client';
import { messageToolboxActions } from '../../../client/lib/MessageToolboxActions';
import { imperativeModal } from '../../../client/lib/imperativeModal';
import { messageArgs } from '../../../client/lib/utils/messageArgs';
import ReadReceiptsModal from '../../../client/views/room/modals/ReadReceiptsModal';

Meteor.startup(() => {
	Tracker.autorun(() => {
		const enabled = settings.get('Message_Read_Receipt_Store_Users');

		if (!enabled) {
			return messageToolboxActions.remove('receipt-detail');
		}

		messageToolboxActions.add({
			id: 'receipt-detail',
			icon: 'info-circled',
			label: 'Info',
			context: ['starred', 'message', 'message-mobile', 'threads'],
			action(_, props) {
				const { message = messageArgs(this).msg } = props;
				imperativeModal.open({
					component: ReadReceiptsModal,
					props: { messageId: message._id, onClose: imperativeModal.close },
				});
			},
			order: 10,
			group: 'menu',
		});
	});
});
