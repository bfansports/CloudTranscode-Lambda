var lambda = require('./index').handler;

lambda({
    Records: [
	{
            eventVersion: "2.0",
            eventSource: "aws:s3",
            awsRegion: "us-east-1",
            eventTime: "2015-04-09T00:00:00.000Z",
            eventName: "ObjectCreated:Post",
            userIdentity: {principalId: "koxon"},
            requestParameters: {sourceIPAddress: "127.0.0.1"},
            responseElements: {
		"x-amz-request-id": "AAAAAAAAAAAAAAAA",
		"x-amz-id-2": "example+uvBeYL11YHRGvzOb5qQz7cwxh7AzPlE+zuM2zRN6vTvd/1Qe0TJpKPCvZBoO4dB0gqM="
            },
            s3: {
		s3SchemaVersion: "1.0",
		configurationId: "ProcessUploads",
		bucket: {
                    name: "sportarchive-dev-orgs",
                    ownerIdentity: {principalId: "aws-sa-dev"},
                    arn: "arn:aws:s3:::sportarchive-dev-orgs"
		},
		object: {
                    key: "TheMasters/videos/df32bc480c7ad56e66975270f1b64e0179025ffeaae63ac7880d6b2ca79be070/df32bc480c7ad56e66975270f1b64e0179025ffeaae63ac7880d6b2ca79be070.mp4",
                    size: 20318159,
                    eTag: "5f520f1d01a49ee5b8a2602a854cab60-4"
		}
            }
	}
    ]
}, {
    fail: function (error) {
        console.log('Failed:', error);
        process.exit(1);
    },
    succeed: function(result) {
        console.log('Succeeded:', result);
        process.exit();
    }
});

