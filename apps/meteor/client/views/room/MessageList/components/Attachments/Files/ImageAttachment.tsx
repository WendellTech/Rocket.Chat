import type { ImageAttachmentProps } from '@rocket.chat/core-typings';
import { useMediaUrl } from '@rocket.chat/ui-contexts';
import type { FC } from 'react';
import React from 'react';

import MarkdownText from '../../../../../../components/MarkdownText';
import Attachment from '../../../../../../components/message/Attachments/Attachment';
import AttachmentContent from '../../../../../../components/message/Attachments/Attachment/AttachmentContent';
import Image from '../../../../../../components/message/Attachments/components/Image';
import { useLoadImage } from '../../../../../../components/message/Attachments/hooks/useLoadImage';
import MessageCollapsible from '../../MessageCollapsible';
import MessageContentBody from '../../MessageContentBody';

export const ImageAttachment: FC<ImageAttachmentProps> = ({
	title,
	image_url: url,
	image_preview: imagePreview,
	image_size: size,
	image_dimensions: imageDimensions = {
		height: 360,
		width: 480,
	},
	description,
	descriptionMd,
	title_link: link,
	title_link_download: hasDownload,
}) => {
	const [loadImage, setLoadImage] = useLoadImage();
	const getURL = useMediaUrl();

	return (
		<Attachment>
			{descriptionMd ? <MessageContentBody md={descriptionMd} /> : <MarkdownText parseEmoji content={description} />}
			<MessageCollapsible title={title} hasDownload={hasDownload} link={getURL(link || url)} size={size}>
				<AttachmentContent>
					<Image
						{...imageDimensions}
						loadImage={loadImage}
						setLoadImage={setLoadImage}
						dataSrc={getURL(link || url)}
						src={getURL(url)}
						previewUrl={`data:image/png;base64,${imagePreview}`}
					/>
				</AttachmentContent>
			</MessageCollapsible>
		</Attachment>
	);
};