use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(DeviceProject::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(DeviceProject::FolderId)
                            .integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(DeviceProject::DeviceId).integer().not_null())
                    .col(
                        ColumnDef::new(DeviceProject::RemotePath)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeviceProject::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    // 项目删掉，远程关联跟着删；设备还有项目时不许删设备。
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_device_project_folder")
                            .from(DeviceProject::Table, DeviceProject::FolderId)
                            .to(Folder::Table, Folder::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_device_project_device")
                            .from(DeviceProject::Table, DeviceProject::DeviceId)
                            .to(Device::Table, Device::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(DeviceProject::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum DeviceProject {
    Table,
    FolderId,
    DeviceId,
    RemotePath,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum Device {
    Table,
    Id,
}
