import { Files } from './store';
import { Logger } from '@/logger';
import { DEFAULT_REGION } from './aws';

interface CloudSessionStoreFile {
    region: string[];
}
const logger = Logger.getInstance()
let filesStorage: Files;
const fileName = "cloud-session.json"
let storeState: CloudSessionStoreFile = {
    region: []
}

export async function initCloudStore(files: Files) {
    try {
        filesStorage = files
        const current = await filesStorage.read(fileName)
        if (current === undefined) {
            logger.info("Writing cloud session files")
            filesStorage.write(fileName, `{\"region\":[\"${DEFAULT_REGION}\"]}`)
        } else {
            logger.info("Existing cloud session file exists")
            storeState = JSON.parse(current)


        }
    } catch (error) {
        logger.error(`Cloud Store error: ${error}`)
    }
}

export async function addRegion(region: string) {

    try {
        if (!storeState.region.includes(region))
            storeState.region.push(region)
        const updatedData = JSON.stringify(storeState, null, 2);
        filesStorage.write(fileName, updatedData)
    } catch (error) {
        console.error('Error handling the JSON file:', error);

    }
}

export async function removeRegion(region: string) {
    try {
        storeState.region = storeState.region.filter(r => r !== region)
        const updatedData = JSON.stringify(storeState, null, 2);
        filesStorage.write(fileName, updatedData)
    } catch (error) {
        console.error('Error handling the JSON file:', error);

    }
}

export async function updateRegion(regions: string[]) {
    try {
        storeState.region = regions
        const updatedData = JSON.stringify(storeState, null, 2);
        filesStorage.write(fileName, updatedData)
    } catch (error) {
        console.error('Error handling the JSON file:', error);

    }
}

export function getActiveRegions(): string[] {
    return storeState.region
}
