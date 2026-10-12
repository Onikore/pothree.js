import {EptBinaryLoader} from "./BinaryLoader.js";
import {state} from "../../state.js";

export class EptZstandardLoader extends EptBinaryLoader {
    extension() {
        return '.zst';
    }

    workerPath() {
        return state.scriptPath + '/workers/EptZstandardDecoderWorker.js';
    }
};

