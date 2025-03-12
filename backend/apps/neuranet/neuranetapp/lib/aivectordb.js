/** 
 * A simple vector database/indexer/matcher. Uses flat, in-memory index and 
 * an exhaustive search. Expected to be slow as the index size increases beyond
 * millions of (typically sized) documents on a 8GB VM/container, unless sharding 
 * and multiple index/node combinations are used.  Only supports pure text documents,
 * other document types should be converted to text before indexing.
 * 
 * Uses cosine similarity for queries. Supports pluggable embedding generators
 * to support various AI models for generating embeddings.
 * 
 * Supports CRUD operations on the index, and query to return topK matching vectors.
 * 
 * Not ACID and the serialization to the disk is "best effort, and when possible",
 * but automatic.
 * 
 * But on the plus side - needs nothing else, runs in-process, etc. 
 * 
 * Use exports.get_vectordb factory to get a vector DB for a new or existing index.
 * That ensures the DB is properly initialized on the disk before using it (await for it).
 * 
 * Memory calculations (excluding data portion) - each vector with 1500 dimensions
 * would be 6K as 1500*64bits = 6KB. So an index with 30,000 documents (at typically 
 * 10 vectors per document) would be 30000*10*6/1000 MB = 1800 MB or 1.8GB. 
 * 300,000 such documents would be 18 GB and 500,000 (half a million) documents 
 * would be approximately 30 GB of memory. So for approx 100,000 documents we'd need
 * 6GB of RAM. 
 * 
 * The module supports multiple databases, a strategy to shard would be to break logical
 * documents types into independent databases, shard them over multiple machines. This 
 * would significantly reduce per machine memory needed, and significantly boost performance.
 * 
 * TODO: An upcoming new algorithm for fast, 100% accurate exhaustive search would be
 * added by Tekmonks once testing is completed. Making this the easiest, and a really 
 * fast vector database for all types of production loads and AI applications. Algo will be 
 * based on quantized buckets for cosine distance from a reference vector (middle of dimensional
 * cube for the vectors may be a good starting reference vector). Unlike KNN algorithms which are
 * approximate (as they divide the space), such an approach would be 100% accurate but won't be
 * as fast as KNN as the resulting quantized buckets will not be encoding the direction of the
 * distance, so an exhaustive search inside the bucket would still be needed. But the bucket size
 * which depends on the quantization interval can be controlled making this still a good approach.
 * 
 * (C) 2023 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const memfs = require(`${CONSTANTS.LIBDIR}/memfs.js`);
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const blackboard = require(`${CONSTANTS.LIBDIR}/blackboard.js`);
const conf = require(`${NEURANET_CONSTANTS.CONFDIR}/aidb.json`);
const textsplitter = require(`${NEURANET_CONSTANTS.LIBDIR}/textsplitter.js`);
const timed_expiry_cache = require(`${CONSTANTS.LIBDIR}/timedcache.js`).newcache(NEURANET_CONSTANTS.CONF.fastcache_timeout);

const dbs = {}, VECTOR_INDEX_NAME = "vector", TEXT_INDEX_NAME = "text", METADATA_INDEX_NAME = "mdindex", 
    METADATA_DOCID_KEY_PROPERTY_NAME="aidbdocidkey", METADATA_DOCID_KEY_DEFAULT="aidb_docid", 
    VECTORDB_FUNCTION_CALL_TOPIC = "vectordb.functioncall", MAX_LOG_NON_VERBOSE_TRUNCATE = 250, 
    DB_OBJECT_TEMPLATE = {path: "", distributed: conf.distributed},
    EMPTY_VECTOR_OBJECT = {vector:[], hash: undefined, length: 0}, 
    EMPTY_METADATA_OBJECT = {vector_objects: [], metadata: undefined}, TEMP_MEMORY = {};

let blackboard_initialized = false;
if (!blackboard_initialized) {_initBlackboardHooks(); blackboard_initialized = true;}

/**
 * Inits the vector DB whose path is given.
 * @param {string} db_path_in The DB path
 * @param {string} metadata_docid_key The document ID key inside metadata
 * @throws Exception on errors 
 */
exports.initAsync = async (db_path_in, metadata_docid_key) => {
    if (!blackboard_initialized) throw ("TF.IDF blackboard hooks not initialized, severe error!");

    dbs[_get_db_hash(db_path_in)] = {...(serverutils.clone(DB_OBJECT_TEMPLATE)), path: db_path_in};
    dbs[_get_db_hash(db_path_in)][METADATA_DOCID_KEY_PROPERTY_NAME] = metadata_docid_key;

    try {await memfs.access(db_path_in, fs.constants.R_OK)} catch (err) {
        _log_error("Vector DB path folder does not exist. Initializing to an empty DB", db_path_in, err); 
        await memfs.mkdir(db_path_in, {recursive:true});
        return;
    }
}

/**
 * Reads the DB from the disk to the memory
 * @param {string} db_path_in The DB path
 * @param {string} metadata_docid_key The document ID key inside metadata
 * @throws Exception on errors 
 */
exports.read_db = async (_db_path_in, _metadata_docid_key) => {
    // nop
}

/**
 * Saves the DB to the file system.
 * @param {string} db_path_out DB path out
 * @param {boolean} force Forces the save even if DB is not dirty
 */
exports.save_db = async (_db_path_out, _force) => {
   // nop
}

/**
 * Creates and adds a new vector to the DB.
 * @param {array} vector The vector to add, if null, then embedding generator will be used to create a new vector
 * @param {object} metadata The metadata object for the vector
 * @param {string} text The associated text for the vector
 * @param {function} embedding_generator The embedding generator of format `vector = await embedding_generator(text)`
 * @param {string} db_path The DB path where this DB is stored. Must be a folder.
 * @param {boolean} dontserializeindex To stop index serialization 
 * @throws Exception on errors 
 */
exports.create = exports.add = async (vector, metadata, text, embedding_generator, db_path, dontserializeindex) => {
    if ((!vector) && embedding_generator && text) try {vector = await embedding_generator(text);} catch (err) {
        _log_error("Vector embedding generation failed", db_path, err); 
        return false;
    }
    if (!vector) {  // nothing to do
        _log_error("No vector found or generated for Vector DB update, skipping create/add operation", db_path, "Either the embedding generator failed or no text was provided to embed"); 
        return false;
    }

    const dbToUse = dbs[_get_db_hash(db_path)]; if (!dbToUse) {
        _log_error("No vector databse found at the path given. Maybe it was not initialized?", db_path, "No database found"); 
        return false;
    }
    if (!metadata[dbToUse[METADATA_DOCID_KEY_PROPERTY_NAME]]) throw new Error("Missing document ID in metadata.");

    const vectorhash = _get_vector_hash(vector, metadata, dbToUse), tempMemHash = _getTempmemHash(dbToUse, metadata);
    if (!TEMP_MEMORY[tempMemHash]) {    
        const mdobjectTemp = await _readMetadataObject(dbToUse, metadata, true);    // multiple requests batch at the await here
        if (!TEMP_MEMORY[tempMemHash]) TEMP_MEMORY[tempMemHash] = {};
        if (!TEMP_MEMORY[tempMemHash].files) TEMP_MEMORY[tempMemHash].files = [];
        if (!TEMP_MEMORY[tempMemHash].mdObject) TEMP_MEMORY[tempMemHash].mdObject = mdobjectTemp; // this sets the unique object for all awaits reconciling them
    }
    const mdobject = TEMP_MEMORY[tempMemHash].mdObject;    // now everyone is using the same object for the same metadata
    if ((mdobject.vector_objects.indexOf(vectorhash) == -1) && (!_isDuplicateRequest(dbToUse, metadata, text))) {          
        const vectorObject = serverutils.clone(EMPTY_VECTOR_OBJECT); vectorObject.vector = serverutils.clone(vector); 
        vectorObject.hash = vectorhash; vectorObject.length = _getVectorLength(vector);
        const vectorfilePath = _getFilePathForVector(dbToUse, vectorObject.hash);
        const mdfilePath = _getFilePathForMetadata(dbToUse, metadata);
        mdobject.vector_objects.push(vectorObject.hash);
        try {
            if (!dontserializeindex) TEMP_MEMORY[tempMemHash].files.push({path: mdfilePath, data: JSON.stringify(mdobject), encoding: "utf8"});
            TEMP_MEMORY[tempMemHash].files.push({path: vectorfilePath, data: JSON.stringify(vectorObject), encoding: "utf8"});
            TEMP_MEMORY[tempMemHash].files.push({path: _getTextfilePathForVector(dbToUse, vectorObject.hash), data: text||"", encoding: "utf8"});
        } catch (err) {
            _deleteVectorObject(db_path, vectorObject.hash, metadata);
            _log_error(`Vector or its associated text file could not be saved`, db_path, err);
            return false;
        }
        _log_info(`Added vector ${_truncate_vector(vector)} with hash ${vectorObject.hash} to DB`, db_path);
    } else _log_warning(`Skipping re-ingestion for vector ${_truncate_vector(vector)} with to the DB as it already exists. To re-ingest use delete first or use update.`, db_path);
    
    return vector;
}

/**
 * Reads the given vector from the database and returns its object.
 * @param {array} vector The vector to read
 * @param {object} metadata The associated metadata
 * @param {boolean} notext Do not return associated text
 * @param {string} db_path The DB path where this DB is stored. Must be a folder.
 * @returns Vector object of the format `{vector:[...], metadata:{...}}`
 * @throws Exception on errors 
 */
exports.read = async (vector, metadata, notext, db_path) => {
    const dbToUse = dbs[_get_db_hash(db_path)], vectorhash = _get_vector_hash(vector, metadata, dbToUse);
    const vectorObject = await _readVectorObject(dbToUse, vectorhash);
    if (!vectorObject) return null;    // not found

    let text; 
    if (!notext) try {  // read the associated text unless told not to, don't cache these files
        text = await memfs.readFile(_getTextfilePathForVector(dbToUse, vectorhash), {encoding: "utf8", memfs_dontcache: true});
    } catch (err) { 
        _log_error(`Vector DB text file ${_getTextfilePathForVector(dbToUse, vectorhash)} not found or error reading`, db_path, err); 
        return null;
    }
    
    return {vector: vectorArray, text, hash: vectorHash, metadata: metadataJSON[metadataHash].metadata, length: vectorLength};
}

/**
 * Updates the vector DB's old metadata with the new metadata provided.
 * @param {object} oldmetadata The old metadata
 * @param {object} newmetadata The new metadata
 * @param {string} db_path The DB path where this DB is stored. Must be a folder.
 * @throws Exception on errors 
 */
exports.update = async (oldmetadata, newmetadata, db_path) => {
    const dbToUse = dbs[_get_db_hash(db_path)];
    const metadataObjectOld = await _readMetadataObject(dbToUse, oldmetadata), 
        metadataObjectNew = await _readMetadataObject(dbToUse, newmetadata, true);
    if (!metadataObjectOld) throw new Error("Metadata to update from not found");
    if (!newmetadata) throw new Error("Metadata to update to not created");
    metadataObjectNew.vector_objects = metadataObjectOld.vector_objects;
    const mdindexfileNew = _getFilePathForMetadata(newmetadata), mdindexfileOld = _getFilePathForMetadata(oldmetadata);
    await memfs.writeFile(mdindexfileNew, JSON.stringify(mdobject)); memfs.rm(mdindexfileOld);
}

/**
 * Deletes the given vector from the DB.
 * @param {array} vector The vector to update
 * @param {string} db_path The DB path where this DB is stored. Must be a folder.
 * @throws Exception on errors 
 */
exports.delete = async (vector, metadata, db_path) => {
    const dbToUse = dbs[_get_db_hash(db_path)], vectorhash = _get_vector_hash(vector, metadata, dbToUse); 

    try {
        await _deleteVectorObject(db_path, vectorhash, metadata); 
        return true;
    } catch (err) {
        _log_error(`Vector or the associated text file ${_getTextfilePathForVector(dbToUse, vectorhash)} could not be deleted`, db_path, err);
        return false;
    }
}

/**
 * Queries the vector database and returns the results.
 * @param {array} vectorToFindSimilarTo The vector of floats to search similar to, if not provided, searches all objects
 * @param {number} topK The topK results to return, set to a negative number to return all results
 * @param {float} min_distance The minimum similarity distance - can be a float between 0 to 1
 * @param {function} metadata_filter_function The metadata filter function
 * @param {boolean} notext If document text is not needed, set it to true
 * @param {string} db_path The database path
 * @returns An array of {vector, similarity, metadata, text} objects matching the results.
 */
exports.query = async function(vectorToFindSimilarTo, topK, min_distance, metadata_filter_function_or_metadata, notext, 
        db_path, distributed_query=true) {
    const dbToUse = dbs[_get_db_hash(db_path)]; if (!dbToUse) return [];   // no DB, no matches
    const _searchSimilarities = async _ => {
        const similaritiesOtherReplicas = dbToUse.distributed && distributed_query ? 
            await _getDistributedSimilarities([vectorToFindSimilarTo, topK, min_distance, metadata_filter_function_or_metadata, 
                notext, db_path]) : [];
        const resolved_metadata_filter_function_or_metadata = typeof metadata_filter_function_or_metadata === "string" ? new Function(["metadata"], metadata_filter_function_or_metadata) : metadata_filter_function_or_metadata;
        const similaritiesThisReplica = await _search_singlethreaded(dbToUse, vectorToFindSimilarTo, resolved_metadata_filter_function_or_metadata);
        const similaritiesFinal = [...similaritiesOtherReplicas, ...similaritiesThisReplica];
        return similaritiesFinal;
    }

    let similarities = await _searchSimilarities();
        
    if (vectorToFindSimilarTo) similarities.sort((a,b) => b.similarity - a.similarity);
    const results = []; for (const similarity_object of similarities) { 
        if (results.length == topK) break;  // done filtering
        if (vectorToFindSimilarTo && min_distance && (similarity_object.similarity < min_distance)) break; // filter for minimum distance if asked
        results.push(similarity_object);
    }
    similarities = []; // try to free memory asap

    if (!notext) for (const [i, similarity_object] of Object.entries(results)) {
        if (similarity_object.text) continue; // already has the text,no need to get the text
        const associatedTextFilePath = _getTextfilePathForVector(dbToUse, similarity_object.vectorhash);
        try { similarity_object.text = await memfs.readFile(associatedTextFilePath, "utf8") } catch (err) { 
            _log_error(`Vector DB text file ${associatedTextFilePath} not found or error reading, deleting this vector from the final results`, db_path, err); 
            delete result[i];   // remove this result
        }
    }

    return results; 
}

/**
 * Deletes the given vectors from the DB.
 * @param {array} vectors Array of vectors to delete
 * @param {object} metadata The metadata for all these vectors
 * @param {string} db_path The DB path where this DB is stored. Must be a folder.
 */
exports.uningest = async (metadata, db_path) => { 
    const metadataToDelete = await _readMetadataObject(metadata);
    if (!metadataToDelete) return;  // already doesn't exist, treat as success

    const vectorsToDelete = metadataToDelete.vector_objects;
    for (const vector of vectorsToDelete) await exports.delete(vector, metadata, db_path); 
}

/**
 * Ingests a stream into the database. Memory efficient and should be the function of choice to use
 * for ingesting large documents into the database. 
 * @param {object} metadata The associated metadata
 * @param {object} stream The incoming text data stream (must be text)
 * @param {string} encoding The encoding for the text stream, usually UTF8
 * @param {number} chunk_size The chunk size - must be less than what is the maximum for the embedding_generator, it is in bytes
 * @param {array} split_separators The characters on which we can split
 * @param {number} overlap The overlap characters for each split. Not sure this is useful, usually 0 should be ok.
 * @param {function} embedding_generator The embedding generator, see create for format
 * @param {string} db_path The DB path where this DB is stored. Must be a folder.
 * @param {boolean} awaitWrites Will force the code to return only after all writes have completed
 * @returns {boolean} true on success or throws errors otherwise
 * @throws Errors if things go wrong.
 */
exports.ingeststream = async function(metadata, stream, encoding="utf8", chunk_size, split_separators, overlap, embedding_generator, 
        db_path, awaitWrites) {
    
    const dbToUse = dbs[_get_db_hash(db_path)]; if (!dbToUse) {
        _log_error(`Error ingesting document with metadata ${JSON.stringify(metadata)} due to no DB. Maybe it was not initialized?`, db_path);
        return; }
    if (_isDuplicateRequest(dbToUse, metadata, "__temp__")) return Promise.resolve(true); // duplicate ingest stream request

    return new Promise((resolve, reject) => {
        let working_data = Buffer.alloc(0), vectors_ingested = [], had_error = false, waitingPromises = [];

        const _splitWorkingData = forceLastSplit => {
            const splits = textsplitter.getSplits(working_data.toString(encoding), chunk_size, split_separators, overlap);
            if (splits.length) {
                const processLastSplit = forceLastSplit ? true : (splits[splits.length-1].length < 0.5*chunk_size) ? false : true;    // if last split is > 50% of chunk size wanted, just process it 
                if (!processLastSplit) working_data = Buffer.from(splits[splits.length-1]); else working_data = Buffer.alloc(0);
                const splitsToIngest = processLastSplit ? splits : splits.slice(0, -1);
                return splitsToIngest;
            } else return [];
        }

        const _handleError = err => {
            had_error = true; _freeTempMemoryForIngestedData(dbToUse, metadata);
            _log_error(`Vector ingection failed, the related metadata was ${JSON.stringify(metadata)}`, db_path, err); 
            reject(err);
        }

        const _ingestSingleSplit = async split => {
            if (had_error) return;  // ignore new data if old ingestions failed
            const createdVector = await exports.create(undefined, metadata, split, embedding_generator, db_path, true);
            if (!createdVector)_handleError("Unable to inject, creation failed, adding new chunk failed");
            vectors_ingested.push(createdVector);
        }

        stream.on("data", chunk => {
            if (had_error) return;  // ignore new data if old ingestions failed
            working_data = Buffer.concat([working_data, chunk]);
            const splitsToIngest = _splitWorkingData();
            for (const split of splitsToIngest) waitingPromises.push(_ingestSingleSplit(split));
        });

        stream.on("error", err => {
            if (had_error) return;  // ignore new errors if old ingestions failed
            _handleError(`Read stream didn't close properly, ingestion failed. Error was ${err.toString()}`);
        });

        stream.on("end", async _=> {
            if (had_error) return;  // we have already rejected then 
            const splitsToIngest = _splitWorkingData(true); // ingest whatever remains
            for (const split of splitsToIngest) waitingPromises.push(_ingestSingleSplit(split));
            try {
                await Promise.all(waitingPromises); 
                if (awaitWrites) await _flushIngestedDataToDisk(dbToUse, metadata, true, true); 
                else  _flushIngestedDataToDisk(dbToUse, metadata, true, true); 
                resolve(true);
            } catch(err) {reject(err);} 
        });
    });
} 

/**
 * Returns the vector database on the path provided. This is the function of choice to use for all 
 * vector database operations.
 * @param {string} db_path The path to the database. Must be a folder.
 * @param {function} embedding_generator The embedding generator of format `vector = await embedding_generator(text)`
 * @param {string} metadata_docid_key The metadata docid key, is needed and if not provided then assumed to be aidb_docid
 * @returns {object} The vector database object with various CRUD operations.
 */
exports.get_vectordb = async function(db_path, embedding_generator, metadata_docid_key=METADATA_DOCID_KEY_DEFAULT) {
    await exports.initAsync(db_path, metadata_docid_key); 
    return {
        create: async (vector, metadata, text, dontserializeindex) => exports.create(vector, metadata, text, embedding_generator, db_path, dontserializeindex),
        ingest: async (metadata, document, chunk_size, split_separators, overlap) => exports.ingest(metadata, document, 
            chunk_size, split_separators, overlap, embedding_generator, db_path),
        ingeststream: async(metadata, stream, encoding="utf8", chunk_size, split_separators, overlap) => 
            exports.ingeststream(metadata, stream, encoding, chunk_size, split_separators, overlap, 
                embedding_generator, db_path),
        read: async (vector, metadata, notext) => exports.read(vector, metadata, notext, db_path),
        update: async (oldmetadata, newmetadata) => exports.update(oldmetadata, newmetadata, db_path),
        delete: async (vector, metadata) =>  exports.delete(vector, metadata, db_path),    
        uningest: async (metadata) => exports.uningest(metadata, db_path),
        query: async (vectorToFindSimilarTo, topK, min_distance, metadata_filter_function_or_metadata, notext) => exports.query(
            vectorToFindSimilarTo, topK, min_distance, metadata_filter_function_or_metadata, notext, db_path),
        flush_db: async _ => exports.save_db(db_path, true),
        get_path: _ => db_path, 
        get_embedding_generator: _ => embedding_generator,
	    sort: vectorResults => vectorResults.sort((a,b) => b.similarity - a.similarity),
    }
}

/** Internal functions start, not exported. */

// Start: Cosine similarity calculator: Shared function for single threaded search and workers, btw this 
// affects the search performance the most so the code here MUST be fastest, most optimized version we can 
// come up with. Precalculating vector lengths is one such optimization, so that we don't need to calculate 
// any lengths during searching, which saves a lot of CPU time and cycles.
const _cosine_similarity = (v1, v2, lengthV1, lengthV2) => {    
    if (v1.length != v2.length) throw Error(`Can't calculate cosine similarity of vectors with unequal dimensions, v1 dimensions are ${v1.length} and v2 dimensions are ${v2.length}.`);
    let vector_product = 0; for (let i = 0; i < v1.length; i++) vector_product += v1[i]*v2[i];
    if (!lengthV1) lengthV1 = _getVectorLength(v1); if (!lengthV2) lengthV2 = _getVectorLength(v2);
    const cosine_similarity = vector_product/(lengthV1*lengthV2);
    return cosine_similarity;
}
// End: Cosine similarity calculator

async function _search_singlethreaded(dbToUse, vectorToFindSimilarTo, metadata_filter_function_or_metadata) {
    const metadatas_to_search = []; if (!metadata_filter_function_or_metadata instanceof Function) metadatas_to_search = [metadata_filter_function_or_metadata];
    else for (const metadata of await _get_all_metadatas(dbToUse)) if (metadata_filter_function_or_metadata(metadata.metadata)) metadatas_to_search.push(metadata);

    const similarities = [], lengthOfVectorToFindSimilarTo = vectorToFindSimilarTo?
        _getVectorLength(vectorToFindSimilarTo):undefined;
    for (const metadata of metadatas_to_search) for (const vectorHash of metadata.vector_objects) {
        const entryToCompareTo = await _readVectorObject(dbToUse, vectorHash);
        similarities.push({   // calculate cosine similarities
            vector: entryToCompareTo.vector, vectorhash: vectorHash,
            similarity: vectorToFindSimilarTo ? _cosine_similarity(entryToCompareTo.vector, vectorToFindSimilarTo, 
                entryToCompareTo.length, lengthOfVectorToFindSimilarTo) : undefined,
            metadata: metadata.metadata});
    }
    return similarities;
}

async function _deleteVectorObject(db_path, vectorhash, metadata, publish) {
    const dbToUse = dbs[_get_db_hash(db_path)];
    const filepathThisVector = _getFilePathForVector(dbToUse, vectorhash);

    if (!(await _checkFileAccess(filepathThisVector))) { 
        if (publish) {  // we do not have this vector, maybe someone else does, just broadcast it
            _getDistributedResultFromFunction(dbToUse, "_deleteVectorObject", [db_path, vectorhash, metadata, false], true, false);
            return;   // not found locally
        } else return; // we already don't have this, so deletion is "sort of" successful
    } 

    const textFilepathThisVector = _getTextfilePathForVector(dbToUse, vectorhash);
    const mdobject = await _readMetadataObject(dbToUse, metadata);
    if (!mdobject) {_log_error(`Vector's associated metadata file could not be found`, db_path, "");}

    const mdindexFile = _getFilePathForMetadata(dbToUse, metadata);

    try {
        await memfs.unlinkIfExists(filepathThisVector); await memfs.unlinkIfExists(textFilepathThisVector);
        if (mdobject && mdobject.vector_objects.indexOf(vectorhash) != -1) mdobject.vector_objects.splice(mdobject.vector_objects.indexOf(vectorhash), 1);
        if (mdobject && mdobject.vector_objects.length) await memfs.writeFile(mdindexFile, JSON.stringify(mdobject)); else memfs.unlinkIfExists(mdindexFile);
    } catch (err) {
        _log_error(`Vector or its associated text file could not be deleted`, db_path, err);
    }
}

const _getVectorLength = v => Math.sqrt(v.reduce((accumulator, val) => accumulator + (val*val) ));

const _get_db_hash = db_path => path.resolve(db_path);

const _getTextfilePathForVector = (db, vectorHash) => path.resolve(`${db.path}/${TEXT_INDEX_NAME}_${vectorHash}`);

const _freeTempMemoryForIngestedData = (dbToUse, metadata) => delete TEMP_MEMORY[_getTempmemHash(dbToUse, metadata)];

const _getTempmemHash = (dbToUse, metadata)  => dbToUse.path+metadata[dbToUse[METADATA_DOCID_KEY_PROPERTY_NAME]];

const _flushIngestedDataToDisk = async (dbToUse, metadata, rebuildIndex, freeTempMemory) => {
    const temphash = _getTempmemHash(dbToUse, metadata), filesToWrite = TEMP_MEMORY[temphash]?.files||[];
    try {
        for (const file of filesToWrite) await memfs.writeFile(file.path, file.data, file.encoding||"utf8"); 
        if (rebuildIndex) await memfs.writeFile(_getFilePathForMetadata(dbToUse, metadata), JSON.stringify(TEMP_MEMORY[temphash].mdObject||{}), "utf8"); 
        if (freeTempMemory) _freeTempMemoryForIngestedData(dbToUse, metadata);
    } catch (err) { _log_error(`Error writing vector DB file`, dbToUse.path, err) }
}

function _get_vector_hash(vector, metadata, db) {
    const hashAlgo = crypto.createHash("md5"); hashAlgo.update(vector.toString()+metadata[db[METADATA_DOCID_KEY_PROPERTY_NAME]||"__undefined_doc__"]);
    const hash = hashAlgo.digest("hex"); return hash;
}

const _getFilePathForVector = (db, hash) => `${db.path}/${VECTOR_INDEX_NAME}_${hash}`;

const _getFilePathForMetadata = (dbToUse, metadata) => `${dbToUse.path}/${METADATA_INDEX_NAME}_${metadata[dbToUse[METADATA_DOCID_KEY_PROPERTY_NAME]]}`;

const _readVectorObject = async (dbToUse, vectorhash) => {
    try {return JSON.parse(await memfs.readFile(_getFilePathForVector(dbToUse, vectorhash, false), "utf8"))}
    catch (err) {_log_error(`Error reading vector for vector hash ${vectorhash}`, dbToUse.path, err); return null;}
}

async function _get_all_metadatas(dbToUse) {
    const results = []; for (const fileEntry of await memfs.readdir(dbToUse.path)) if (fileEntry.startsWith(METADATA_INDEX_NAME+"_")) {
        try { results.push(JSON.parse(await memfs.readFile(`${dbToUse.path}/${fileEntry}`))); }
        catch (err) {_log_error(`Error reading metadata file ${fileEntry}`, dbToUse.path, err)}
    }
    return results;
}

const _readMetadataObject = async (dbToUse, metadata, create) => {
    const filePath = _getFilePathForMetadata(dbToUse, metadata);
    try {return JSON.parse(await memfs.readFile(filePath, "utf8"))} catch (err) {
        if (!create) {_log_error(`Error reading metadata file for ${filePath}`, dbToUse.path, err); return null;}
        const metadataObject = serverutils.clone(EMPTY_METADATA_OBJECT); metadataObject.metadata = serverutils.clone(metadata);
        await memfs.writeFile(filePath, JSON.stringify(metadataObject));
        return metadataObject;
    }
}

function _isDuplicateRequest(dbToUse, metadata, additional_text_which_can_be_used_to_hash="") {
    const hashAlgo = crypto.createHash("md5"); hashAlgo.update(path.resolve(dbToUse.path)+(metadata[dbToUse[METADATA_DOCID_KEY_PROPERTY_NAME]||"__undefined_doc__"])+additional_text_which_can_be_used_to_hash.toString());
    const hash = "_neuranet_vectordb"+hashAlgo.digest("hex"); 
    if (!timed_expiry_cache.get(hash)) {timed_expiry_cache.set(hash, "present"); return false;}
    else return true;
}

async function _checkFileAccess(filepath, mode) {
    try { await memfs.access(filepath, mode); return true; } 
    catch (err) { return false; }
}

function _initBlackboardHooks() {
    const bboptions = {}; bboptions[blackboard.NOT_LOCAL_ONLY] = true;

    blackboard.subscribe(VECTORDB_FUNCTION_CALL_TOPIC, async msg => {
        const {dbinitparams, function_name, function_params, is_function_private, send_reply, blackboardcontrol} = msg;
        if (!dbinitparams.dbpath) {LOG.error(`Missing DB path for message ${JSON.stringify(msg)}`); return;}
        _log_info(`aivectordb got internal function call for ${function_name}`, dbinitparams.dbpath);

        if (!dbs[_get_db_hash(dbinitparams.dbpath)]) {
            _log_warning(`Unable to locate database ${dbinitparams.dbpath} for distributed function call for ${function_name}. Trying to initialize.`, dbinitparams.dbpath);
            await exports.initAsync(dbinitparams.dbpath, dbinitparams.metadata_docid_key);
            if (!dbs[_get_db_hash(dbinitparams.dbpath)]) {
                _log_error(`Unable to call function ${function_name} as database not found and init failed.`, dbinitparams.dbpath);
                return; // we can't run the function, as we don't have this DB, so this message is not for us
            }
        }
        const functionToCall = is_function_private ? private_functions[function_name] : module.exports[function_name];
        let function_result;
        if (send_reply) function_result = await functionToCall(...function_params); else await functionToCall(...function_params);
        _log_info(`aivectordb sending internal function call result for ${function_name}`, dbinitparams.dbpath);
        if (send_reply) blackboard.sendReply(VECTORDB_FUNCTION_CALL_TOPIC, blackboardcontrol, {reply: function_result});
    }, bboptions);
}

async function _getDistributedSimilarities(query_params) {
    const [_vectorToFindSimilarTo, _topK, _min_distance, _metadata_filter_function_or_metadata, 
        _notext, db_path] = query_params;
    const dbToUse = dbs[_get_db_hash(db_path)]; 

    const replies = await _getDistributedResultFromFunction(dbToUse, "query", query_params);
    if (replies.incomplete) _log_warning(`Received incomplete replies for the query. Results not perfect.`, dbToUse.path);
    const similarities = []; for (const replyObject of replies||[]) if (replyObject.reply) similarities.concat(replyObject.reply);
    return similarities;
}

function _getDistributedResultFromFunction(db, function_name, params, is_function_private=false, needreply=true) {
    LOG.info(`aivectordb sending internal function call for ${function_name}`);

    const msg = { dbinitparams: _createDBInitParams(db), function_params: [...params, false], 
        function_name, is_function_private, send_reply: needreply };
    const bboptions = {}; bboptions[blackboard.NOT_LOCAL_ONLY] = true;
    return new Promise(resolve => blackboard.getReply(VECTORDB_FUNCTION_CALL_TOPIC, 
        msg, conf.cluster_timeout, bboptions, replies=>resolve(replies)));
}

const _createDBInitParams = dbToUse => {return {dbpath: dbToUse.path, metadata_docid_key: dbToUse[METADATA_DOCID_KEY_PROPERTY_NAME]}};
const _log_warning = (message, db_path) => (global.LOG||console).warn(
    `${message}. The vector DB is ${_get_db_hash(db_path)}.`);
const _log_error = (message, db_path, error) => (global.LOG||console).error(
    `${message}. The vector DB is ${_get_db_hash(db_path)}. The error was ${error||"no information"}.`);
const _log_info = (message, db_path, isDebug) => (global.LOG||console)[isDebug?"debug":"info"](
    `${message}. The vector DB is ${_get_db_hash(db_path)}.`);
const _truncate_vector = vector => JSON.stringify(vector).substring(0, MAX_LOG_NON_VERBOSE_TRUNCATE);

const private_functions = {_deleteVectorObject};  // private functions which can be called via distributed function calls
