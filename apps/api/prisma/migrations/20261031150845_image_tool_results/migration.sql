-- CreateTable
CREATE TABLE `ImageResult` (
    `id` CHAR(36) NOT NULL,
    `jobId` CHAR(36) NOT NULL,
    `operation` ENUM('IMAGE_COMPRESS', 'IMAGE_RESIZE', 'IMAGE_CONVERT', 'IMAGE_STRIP_METADATA', 'IMAGE_TO_PDF', 'PDF_COMPRESS', 'DOCX_COMPRESS', 'VIDEO_COMPRESS', 'VIDEO_EXTRACT_AUDIO') NOT NULL,
    `preset` VARCHAR(16) NULL,
    `targetFormat` VARCHAR(8) NULL,
    `inputWidth` INTEGER NULL,
    `inputHeight` INTEGER NULL,
    `outputWidth` INTEGER NULL,
    `outputHeight` INTEGER NULL,
    `metadataStripped` BOOLEAN NOT NULL DEFAULT false,
    `keptOriginal` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ImageResult_jobId_key`(`jobId`),
    INDEX `ImageResult_operation_createdAt_idx`(`operation`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ImageResult` ADD CONSTRAINT `ImageResult_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `ProcessingJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
