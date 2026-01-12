require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto = require("crypto");

const admin = require("firebase-admin");
const port = process.env.PORT || 4000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
function generateTrackingId() {
  const prefix = "ORD";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}
const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log("HEADERS:", req.headers);
  console.log("AUTH HEADER:", req.headers.authorization);
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("garments-tracker");
    const usersCollection = db.collection("users");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");
    const trackingsCollection = db.collection("trackings");

    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "Admin")
        return res
          .status(403)
          .send({ message: "Unauthorized access", role: user?.role });

      next();
    };
    const verifyManager = async (req, res, next) => {
      const email = req.tokenEmail;

      const user = await usersCollection.findOne({ email });

      if (user?.role !== "Manager")
        return res
          .status(403)
          .send({ message: "Unauthorized access", role: user?.role });

      next();
    };
    const logOrderTracking = async (
      orderId,
      trackingId,
      status,
      location = "",
      note = ""
    ) => {
      const log = {
        orderId,
        trackingId,
        status,
        location,
        note,
        createdAt: new Date(),
      };
      return await trackingsCollection.insertOne(log);
    };
    app.get("/user", verifyJWT, verifyAdmin, async (req, res) => {
      const { searchText, role } = req.query;
      const query = {};
      if (searchText) {
        query.$or = [
          { name: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      if (role) {
        query.role = role;
      }

      const result = await usersCollection
        .find(query)
        .sort({ created_at: -1 })
        .toArray();

      res.send(result);
    });
    app.get("/profile", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      console.log(result);
      res.json(result);
    });

    app.patch("/profile", verifyJWT, async (req, res) => {
      try {
        const { name, image } = req.body;
        const email = req.tokenEmail;

        const updateDoc = {};
        if (name) updateDoc.name = name;
        if (image) updateDoc.image = image;

        const result = await usersCollection.updateOne(
          { email },
          { $set: updateDoc }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).send({ message: "User not found or no changes made" });
        }

        res.send({ message: "Profile updated successfully", result });
      } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).send({ message: "Failed to update profile" });
      }
    });

    app.post("/user", async (req, res) => {
      const userData = req.body;
      console.log(userData);
      userData.status = "pending";
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      const query = {
        email: userData.email,
      };
      const alreadyExist = await usersCollection.findOne(query);
      if (alreadyExist) {
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });
    app.get("/user/status", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ status: result?.status });
    });
    app.patch("/update-status", verifyJWT, verifyAdmin, async (req, res) => {
      const { email, status, reason, feedback } = req.body;

      const updateDoc = {
        status,
      };
      if (status === "suspend") {
        updateDoc.reason = reason || "";
        updateDoc.feedback = feedback || "";
      } else {
        updateDoc.reason = "";
        updateDoc.feedback = "";
      }
      const result = await usersCollection.updateOne(
        { email },
        { $set: updateDoc }
      );
      if (result.modifiedCount) {
        res.send({ message: "User status updated successfully" });
      } else {
        res.status(400).send({ message: "No changes were made" });
      }
    });

    app.get("/products", async (req, res) => {
      const result = await productsCollection
        .find({ showOnHomePage: true })
        .sort({ created_at: -1 })
        .limit(6)
        .toArray();

      res.send(result);
    });
    app.patch(
      "/products/:id/home",
      verifyJWT,
      verifyAdmin,

      async (req, res) => {
        const { id } = req.params;

        const { showOnHomePage } = req.body;

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { showOnHomePage } }
        );

        res.send(result);
      }
    );
    app.delete("/products/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      console.log(id);
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });
    app.patch("/products/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const updatedData = req.body;

      updatedData.updated_at = new Date();

      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updatedData,
        }
      );

      res.send(result);
    });

    app.get("/allProducts", async (req, res) => {
      try {
        const {
          search = "",
          category,
          availability,
          priceRange,
          priceMin,
          priceMax,
          sort = "name-asc",
          page = 1,
          limit = 12,
        } = req.query;

        const query = {};

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
          ];
        }

        if (category) {
          query.category = category;
        }

        if (availability === "in-stock") {
          query.availableQuantity = { $gt: 0 };
        } else if (availability === "out-of-stock") {
          query.availableQuantity = { $lte: 0 };
        }

        // priceRange takes precedence over explicit priceMin/priceMax if provided
        let minPrice = priceMin ? Number(priceMin) : undefined;
        let maxPrice = priceMax ? Number(priceMax) : undefined;
        if (priceRange) {
          if (priceRange === "0-50") {
            minPrice = 0;
            maxPrice = 50;
          } else if (priceRange === "50-100") {
            minPrice = 50;
            maxPrice = 100;
          } else if (priceRange === "100-250") {
            minPrice = 100;
            maxPrice = 250;
          } else if (priceRange === "250+") {
            minPrice = 250;
            maxPrice = undefined;
          }
        }

        if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
          query.price = {};
          if (Number.isFinite(minPrice)) query.price.$gte = minPrice;
          if (Number.isFinite(maxPrice)) query.price.$lte = maxPrice;
        }

        let sortStage = { title: 1 };
        if (sort === "price-asc") sortStage = { price: 1 };
        else if (sort === "price-desc") sortStage = { price: -1 };
        else if (sort === "stock-desc") sortStage = { availableQuantity: -1 };
        else if (sort === "newest") sortStage = { created_at: -1 };

        const pageNumber = Math.max(1, parseInt(page, 10) || 1);
        const limitNumber = Math.min(
          50,
          Math.max(1, parseInt(limit, 10) || 12)
        );
        const skip = (pageNumber - 1) * limitNumber;

        const total = await productsCollection.countDocuments(query);
        const items = await productsCollection
          .find(query)
          .sort(sortStage)
          .skip(skip)
          .limit(limitNumber)
          .toArray();

        res.send({
          items,
          total,
          page: pageNumber,
          pages: Math.max(1, Math.ceil(total / limitNumber)),
          limit: limitNumber,
        });
      } catch (error) {
        console.error("/allProducts error", error);
        res.status(500).send({ message: "Failed to fetch products" });
      }
    });
    app.post("/allProducts", verifyJWT, verifyManager, async (req, res) => {
      const productData = req.body;
      productData.created_By = productData.email;
      productData.created_at = new Date();

      console.log(productData);

      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });
    app.get("/allProducts/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log("PayMent Info", paymentInfo);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: Math.round(Number(paymentInfo.price) * 100),
              product_data: {
                name: paymentInfo.title,
                images: paymentInfo.images?.slice(0, 1) || [],
              },
            },
            quantity: Number(paymentInfo.quantity),
          },
        ],
        customer_email: paymentInfo.Buyer.email,

        mode: "payment",
        metadata: {
          productId: paymentInfo.productId,
          productName: paymentInfo.title,
          BuyerName: paymentInfo.Buyer.name,
          BuyerEmail: paymentInfo.Buyer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancel`,
      });
      console.log("hello from session", session);
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      console.log("from sessionId", sessionId);

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("Stripe session metadata:", session.metadata);

      const product = await productsCollection.findOne({
        _id: new ObjectId(session.metadata.productId),
      });

      if (!product)
        return res.status(404).send({ message: "Product not found" });

      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });

      const trackingId = generateTrackingId();

      if (session.status === "complete" && !order) {
        const orderInfo = {
          productId: product._id,
          trackingId: trackingId,
          transactionId: session.payment_intent,

          buyer: {
            name: session.metadata.BuyerName,
            email: session.metadata.BuyerEmail,
          },

          product: {
            name: product.title,
            category: product.category,
            image: product.images?.[0] || "",
            price: product.price,
          },

          quantity: 1,
          totalPrice: session.amount_total / 100,
          paymentMethod: "Stripe",
          payment_status: "paid",
          paidAt: new Date(),
          status: "pending",
          approvedBy: null,
          approvedAt: null,
          rejectedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await ordersCollection.insertOne(orderInfo);
        const orderId = result.insertedId;

        await productsCollection.updateOne(
          { _id: product._id },
          { $inc: { availableQuantity: -1 } }
        );

        await logOrderTracking(orderId, trackingId, "Order Created");

        return res.send({
          success: true,
          orderId: result.insertedId,
          trackingId,
          transactionId: session.payment_intent,
        });
      }

      return res.send({
        success: false,
        message: "Order already exists or payment not complete",
        transactionId: session.payment_intent,
        trackingId,
      });
    });
    app.post("/create-cod-order", async (req, res) => {
      const { productId, quantity, buyer } = req.body;

      const product = await productsCollection.findOne({
        _id: new ObjectId(productId),
      });

      if (!product)
        return res.status(404).send({ message: "Product not found" });

      const trackingId = generateTrackingId();

      const orderInfo = {
        productId: product._id,
        trackingId: trackingId,
        transactionId: null,

        buyer: {
          name: buyer.name,
          email: buyer.email,
        },

        product: {
          name: product.title,
          category: product.category,
          image: product.images?.[0] || "",
          price: product.price,
        },

        quantity: quantity || 1,
        totalPrice: product.price * (quantity || 1),
        paymentMethod: "CashOnDelivery",
        payment_status: "cod",
        paidAt: null,
        status: "pending",
        approvedBy: null,
        approvedAt: null,
        rejectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await ordersCollection.insertOne(orderInfo);
      const orderId = result.insertedId;
      await productsCollection.updateOne(
        { _id: product._id },
        { $inc: { availableQuantity: -1 } }
      );

      await logOrderTracking(orderId, trackingId, "Order Created (COD)");

      return res.send({
        success: true,
        orderId: result.insertedId,
        trackingId,
        message: "COD Order created successfully",
      });
    });
    app.get("/orders", verifyJWT, async (req, res) => {
      try {
        const { searchText, status, page = 1, limit = 5 } = req.query;

        const query = {};

        if (searchText) {
          query.$or = [
            { "buyer.name": { $regex: searchText, $options: "i" } },
            { "buyer.email": { $regex: searchText, $options: "i" } },
          ];
        }

        if (status) {
          query.status = status;
        }

        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const totalOrders = await ordersCollection.countDocuments(query);

        const orders = await ordersCollection
          .find(query)
          .sort({ created_at: -1 })
          .skip(skip)
          .limit(limitNumber)
          .toArray();

        res.send({
          orders,
          totalOrders,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch orders" });
      }
    });

    app.get("/orders/:id", async (req, res) => {
      const id = req.params.id;
      const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
      const trackingHistory = await trackingsCollection
        .find({ trackingId: result.trackingId })
        .sort({ createdAt: 1 })
        .toArray();
      res.send({ ...result, trackingHistory });
    });
    app.get("/manager-created", verifyJWT, verifyManager, async (req, res) => {
      const { email, search, category } = req.query;

      const query = {
        created_By: email,
      };

      if (search) {
        query.title = { $regex: search, $options: "i" };
      }

      if (category) {
        query.category = category;
      }

      const products = await productsCollection.find(query).toArray();
      res.send(products);
    });
    app.patch(
      "/manage-products/:id",
      verifyJWT,
      verifyManager,
      async (req, res) => {
        const { id } = req.params;
        const updatedData = req.body;

        updatedData.updated_at = new Date();

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: updatedData,
          }
        );

        res.send(result);
      }
    );
    app.get("/orders-pending", async (req, res) => {
      const orders = await ordersCollection
        .find({ status: "pending" })
        .toArray();

      res.send(orders);
    });
    app.patch(
      "/orders-pending/:id",
      verifyJWT,
      verifyManager,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;

        const updateDoc = {
          status,
        };

        if (status === "approved") {
          updateDoc.approvedAt = new Date();
          updateDoc.updatedAt = new Date();
        }

        if (status === "rejected") {
          updateDoc.rejectedAt = new Date();
          updateDoc.updatedAt = new Date();
        }

        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateDoc }
        );

        res.send(result);
      }
    );

    app.get("/approve-orders", async (req, res) => {
      const orders = await ordersCollection
        .find({ status: "approved" })
        .toArray();
      res.send(orders);
    });

    app.get("/my-orders", async (req, res) => {
      const { email } = req.query;
      const query = { "buyer.email": email };
      const orders = await ordersCollection.find(query).toArray();
      res.send(orders);
    });

    app.delete("/my-orders/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      console.log(id);
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.get("/track-order/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const items = await trackingsCollection
          .find({ orderId: new ObjectId(id) })
          .sort({ createdAt: 1 })
          .toArray();

        const trackOrder = items.map((it) => ({
          status: it.status,
          location: it.location,
          note: it.note,
          dateTime: it.createdAt,
        }));

        res.send({ trackOrder, orderId: id });
      } catch (error) {
        console.error("Error tracking order:", error);
        res.status(500).send({
          message: "Failed to fetch tracking",
          error: error?.message,
        });
      }
    });

    app.patch(
      "/track-order/:orderId",
      verifyJWT,
      verifyManager,
      async (req, res) => {
        const { orderId } = req.params;
        const { status, location, note } = req.body;

        if (!status) {
          return res.status(400).send({
            success: false,
            message: "Status is required",
          });
        }
        const order = await ordersCollection.findOne({
          _id: new ObjectId(orderId),
        });
        const log = {
          orderId: order._id,
          trackingId: order.trackingId,
          status,
          location: location || "",
          note: note || "",
          createdAt: new Date(),
        };

        await trackingsCollection.insertOne(log);

        res.send({
          success: true,
          message: "Timeline updated successfully",
        });
      }
    );

    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
