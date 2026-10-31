-- CreateTable
CREATE TABLE `Admin` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Admin_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminSession` (
    `id` CHAR(36) NOT NULL,
    `adminId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ipAddress` VARCHAR(64) NULL,

    UNIQUE INDEX `AdminSession_tokenHash_key`(`tokenHash`),
    INDEX `AdminSession_adminId_idx`(`adminId`),
    INDEX `AdminSession_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `File` (
    `id` CHAR(36) NOT NULL,
    `role` ENUM('UPLOAD', 'OUTPUT') NOT NULL DEFAULT 'UPLOAD',
    `originalName` VARCHAR(255) NOT NULL,
    `storedName` VARCHAR(80) NOT NULL,
    `extension` VARCHAR(16) NOT NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `category` VARCHAR(16) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `storageArea` VARCHAR(16) NOT NULL,
    `storagePath` VARCHAR(255) NOT NULL,
    `checksum` CHAR(64) NOT NULL,
    `status` ENUM('UPLOADED', 'PROCESSING', 'AVAILABLE', 'FAILED', 'DELETED') NOT NULL DEFAULT 'UPLOADED',
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `File_storedName_key`(`storedName`),
    INDEX `File_createdAt_idx`(`createdAt`),
    INDEX `File_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `File_category_createdAt_idx`(`category`, `createdAt`),
    INDEX `File_expiresAt_status_idx`(`expiresAt`, `status`),
    INDEX `File_checksum_idx`(`checksum`),
    INDEX `File_role_createdAt_idx`(`role`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProcessingJob` (
    `id` CHAR(36) NOT NULL,
    `fileId` CHAR(36) NOT NULL,
    `operation` ENUM('IMAGE_COMPRESS', 'IMAGE_RESIZE', 'IMAGE_CONVERT', 'IMAGE_STRIP_METADATA', 'IMAGE_TO_PDF', 'PDF_COMPRESS', 'DOCX_COMPRESS', 'VIDEO_COMPRESS', 'VIDEO_EXTRACT_AUDIO') NOT NULL,
    `options` JSON NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `originalSizeBytes` BIGINT NOT NULL,
    `outputSizeBytes` BIGINT NULL,
    `outputFileId` CHAR(36) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `processingDurationMs` INTEGER NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(500) NULL,
    `resultInfo` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProcessingJob_outputFileId_key`(`outputFileId`),
    INDEX `ProcessingJob_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `ProcessingJob_createdAt_idx`(`createdAt`),
    INDEX `ProcessingJob_fileId_idx`(`fileId`),
    INDEX `ProcessingJob_operation_createdAt_idx`(`operation`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VaultFile` (
    `id` CHAR(36) NOT NULL,
    `displayName` VARCHAR(255) NOT NULL,
    `storedName` VARCHAR(80) NOT NULL,
    `description` VARCHAR(1000) NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `extension` VARCHAR(16) NOT NULL,
    `category` VARCHAR(16) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `checksum` CHAR(64) NOT NULL,
    `storagePath` VARCHAR(255) NOT NULL,
    `uploadedByAdminId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastDownloadedAt` DATETIME(3) NULL,
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `isAvailable` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `VaultFile_storedName_key`(`storedName`),
    INDEX `VaultFile_createdAt_idx`(`createdAt`),
    INDEX `VaultFile_category_createdAt_idx`(`category`, `createdAt`),
    INDEX `VaultFile_displayName_idx`(`displayName`),
    INDEX `VaultFile_uploadedByAdminId_idx`(`uploadedByAdminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` CHAR(36) NOT NULL,
    `adminId` CHAR(36) NULL,
    `action` ENUM('ADMIN_LOGIN', 'ADMIN_LOGIN_FAILED', 'ADMIN_LOGOUT', 'FILE_VIEW', 'FILE_DOWNLOAD', 'FILE_DELETE', 'VAULT_UPLOAD', 'VAULT_VIEW', 'VAULT_DOWNLOAD', 'VAULT_UPDATE', 'VAULT_REPLACE', 'VAULT_DELETE', 'JOB_VIEW', 'SETTINGS_CHANGE') NOT NULL,
    `entityType` VARCHAR(32) NULL,
    `entityId` VARCHAR(64) NULL,
    `metadata` JSON NULL,
    `ipAddress` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    INDEX `AuditLog_adminId_createdAt_idx`(`adminId`, `createdAt`),
    INDEX `AuditLog_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `AuditLog_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AdminSession` ADD CONSTRAINT `AdminSession_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `Admin`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProcessingJob` ADD CONSTRAINT `ProcessingJob_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `File`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProcessingJob` ADD CONSTRAINT `ProcessingJob_outputFileId_fkey` FOREIGN KEY (`outputFileId`) REFERENCES `File`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VaultFile` ADD CONSTRAINT `VaultFile_uploadedByAdminId_fkey` FOREIGN KEY (`uploadedByAdminId`) REFERENCES `Admin`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `Admin`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
