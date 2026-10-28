-- Allow the application to remove an owner's unclaimed Steckbrief after its
-- transaction has locked and verified owner_uuid and status = 'submitted'.
GRANT DELETE ON bbsinfo.submissions TO 'bbsinfo'@'localhost';
