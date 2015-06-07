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
                    key: "TheMog/videos/19c6977c83fa6c7263f65b56734536bf78b2e55ac5673bd6954b660465d1c147/19c6977c83fa6c7263f65b56734536bf78b2e55ac5673bd6954b660465d1c147.mkv",
                    size: 748110865,
                    eTag: "1457e3a2e0b3421ab9836edfd0ecc65f-143"
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

