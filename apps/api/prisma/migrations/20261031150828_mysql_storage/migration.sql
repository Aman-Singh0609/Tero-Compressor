-- CreateTable
CREATE TABLE `StorageObject` (
    `id` CHAR(36) NOT NULL,
    `area` VARCHAR(16) NOT NULL,
    `storedName` VARCHAR(80) NOT NULL,
    `sizeBytes` BIGINT NOT NULL DEFAULT 0,
    `complete` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StorageObject_complete_createdAt_idx`(`complete`, `createdAt`),
    UNIQUE INDEX `StorageObject_area_storedName_key`(`area`, `storedName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StorageChunk` (
    `objectId` CHAR(36) NOT NULL,
    `seq` INTEGER NOT NULL,
    `data` MEDIUMBLOB NOT NULL,

    PRIMARY KEY (`objectId`, `seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `StorageChunk` ADD CONSTRAINT `StorageChunk_objectId_fkey` FOREIGN KEY (`objectId`) REFERENCES `StorageObject`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
