// process.env['FFMPEG_PATH'] = process.cwd();
// process.env['FFPROBE_PATH'] = process.cwd();

//var child_process = require('child_process');
var fs = require('fs');
var util = require('util');
var zlib = require('zlib');
var crypto = require('crypto');
var stream = require('stream');
var AWS = require('aws-sdk');
var async = require('async');
var uuid = require('uuid');
var config = require('./config');
var ffmpeg = require('fluent-ffmpeg');
// var scaleFilter = "scale='min(" + config.videoMaxWidth.toString() + "\\,iw):-2'";
var s3 = new AWS.S3();

process.env['PATH'] += ':' + process.env['LAMBDA_TASK_ROOT'];

function downloadStream(bucket, file, cb) {
    console.log('Starting download');

    var req = s3.getObject({
	Bucket: bucket,
	Key: file
    });

    req.on('error', function(res) {
	//req.end();
	cb('S3 download error: ' + JSON.stringify(res));
    });

    return req.createReadStream();
}

function s3upload(params, filename, cb) {
    s3.upload(params)
	.on('httpUploadProgress', function(evt) {
	    console.log(filename, 'Progress:', evt.loaded, '/', evt.total);
	})
	.send(function(err, data) {
	    console.log(filename, 'complete. Deleting now.');
	    //fs.unlinkSync(filename);
	    cb(err, data);
	})
    ;
}

function uploadFile(src, bucket, key, contentType, cb) {
    console.log('Uploading: '+src);
    console.log('TO: '+bucket+"/"+key);

    var readStream = fs.createReadStream(src);

    var params = {
	Bucket: bucket,
	Key: key,
	ContentType: contentType,
	CacheControl: 'max-age=31536000', // 1 year (60 * 60 * 24 * 365)
	Body: readStream
    };
    
    s3upload(params, src, cb);

    // var md5 = crypto.createHash('md5');
    // var md5pass = new stream.PassThrough;
    // var s3pass = new stream.PassThrough;

    // readStream.pipe(md5pass);
    // readStream.pipe(s3pass);

    // md5pass
    // 	.on('data', function(d) {
    // 	    md5.update(d);
    // 	    console.log("MD5 run");
    // 	})
    // 	.on('end', function() {

    // 	    console.log("MD5 done");
    // 	    console.log(src, 'md5', digest);
	    
    // 	    var digest = md5.digest();

    // 	    if (config.gzip) {
    // 		params.Metadata = {
    // 		    'md5': digest.toString('base64')
    // 		};

    // 		params.ContentEncoding = 'gzip';

    // 		params.Body = s3pass.pipe(
    // 		    zlib.createGzip({
    // 			level: zlib.Z_BEST_COMPRESSION
    // 		    })
    // 		);
    // 	    }
    // 	    else {
    // 		params.Body = s3pass;
    // 	    }
	    
    // 	    console.log("GOGO: "+src);
    // 	    s3upload(params, src, cb);
    // 	})
    // ;
}

function verifyAsset(file, cb) {
    console.log(process.cwd()+' - starting ffprobe: '+file);
    
    // ffmpeg.setFfprobePath(process.cwd());
    
    ffmpeg.ffprobe("/tmp/"+file, function(err, data) {
	console.log('file1 metadata:');
	console.dir(data);
	console.log(err);
	return cb(null, 'ffprobe finished');
    });
}

function createThumb(file, cb) {
    console.log('starting ffmpeg: '+file);
    
    var hash = file.replace(/\..+$/, '');
    
    ffmpeg("/tmp/"+file)
	.screenshots({
	    folder: "/tmp",
	    filename: hash+".png",
	    timemarks: ["50%"],
	    size: "?x159"
	})
	.on('start', function(commandLine) {
	    console.log('Spawned Ffmpeg with command: ' + commandLine);
	})
	.on('progress', function(progress) {
	    console.log('Processing: ' + progress.percent + '% done');
	})
	.on('error', function(err, stdout, stderr) {
	    console.log('Cannot process video: ' + err.message);
	    cb('ffmpeg Error code');
	})
	.on('end', function() {
	    console.log('Transcoding succeeded !');
	    cb(null, 'ffmpeg finished');
	});
}

// function processVideo(file, cb) {
//     var dlFile = '/tmp/'+file;

//     async.series([
// 	function(cb) {
// 	    verifyAsset(file, cb);
// 	},
// 	function(cb) {
// 	    createThumb(file, cb);
// 	},
// 	function(cb) {
// 	    console.log('Deleting download file');
// 	    fs.unlink(dlFile, cb);
// 	}
//     ], cb);
// }

exports.handler = function(event, context) {
    console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
    
    var s3Event = event.Records[0].s3;
    var srcBucket = event.Records[0].s3.bucket.name;
    console.log("src bucket: "+srcBucket);
    var srcKey = 
	decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " ")); 
    console.log("src key: "+srcKey);
    var prefix = srcKey.split('/');
    console.log("prefix arr: "+prefix);
    var file = prefix.splice(prefix.length-1, 1)[0];
    prefix = prefix.join("/");
    console.log("prefix str: "+prefix);
    console.log("file: "+file);
    
    var hash = file.replace(/\..+$/, '');
    console.log("hash: "+hash);

    
    async.series([
	function (cb) { 
	    var dlStream = downloadStream(s3Event.bucket.name, srcKey, cb);
	    dlStream.on('end', function() {
		cb(null, 'download finished');
	    });
	    dlStream.pipe(fs.createWriteStream("/tmp/"+file));
	},
	function (cb) { verifyAsset(file, cb); },
	function (cb) { createThumb(file, cb); },
	function (cb) {
	    //var dstBucket = config.destinationBucket;
	    
	    var dstBucket = srcBucket;
	    async.parallel([
	    	function (cb) { uploadFile("/tmp/"+hash+".png", dstBucket, prefix+"/"+hash+".png", 'image/png', cb); }
	    ], cb);
	}
    ], function(err, results) {
	if (err) context.fail(err);
	else context.succeed(util.inspect(results, {depth: 5}));
    });
};
