-- CreateTable
CREATE TABLE `PdfResult` (
    `id` CHAR(36) NOT NULL,
    `jobId` CHAR(36) NOT NULL,
    `preset` VARCHAR(16) NULL,
    `imagesFound` INTEGER NOT NULL DEFAULT 0,
    `imagesRecompressed` INTEGER NOT NULL DEFAULT 0,
    `keptOriginal` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PdfResult_jobId_key`(`jobId`),
    INDEX `PdfResult_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PdfResult` ADD CONSTRAINT `PdfResult_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `ProcessingJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
