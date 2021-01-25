module.exports = (req, res, next) => {
    const matchingToken = (req.headers || {})['x-api-key'];
    const validToken = process.env.API_TOKEN;
    if (!validToken) throw new Error('Internal Server Error');
    if (matchingToken !== validToken) {
        res.status(401).json({});
    } else {
        next();
    }
};