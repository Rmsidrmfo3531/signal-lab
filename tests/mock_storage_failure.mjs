// Test-only disk fault, with the same fully synthetic transport as pipeline tests.
import './mock_pipeline.mjs';
import fs from 'node:fs';
import path from 'node:path';

const originalRename=fs.renameSync;
const flag=process.env.SIGNAL_LAB_TEST_STORAGE_FAIL_FLAG;
const dataDir=process.env.SIGNAL_LAB_DATA_DIR;
if(!flag||!dataDir)throw Error('Storage failure fixture requires isolated flag and data directory');
const target=path.join(path.resolve(dataDir),'store.json');
fs.renameSync=function(source,destination){
 if(path.resolve(destination)===target&&fs.existsSync(flag))throw Object.assign(Error('Synthetic store rename failure'),{code:'EIO'});
 return originalRename.call(this,source,destination);
};
